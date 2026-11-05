/**
 * The campus identity the Tsinghua plugins share.
 *
 * One student id, one unified-auth password, one device fingerprint. The
 * fingerprint is the interesting part: the school only extends trust to a device
 * it has seen, so minting a fresh one per plugin (or per process) buys a second
 * unknown device and, on the renewal path, a two-factor question.
 *
 * `dsh-thu-automad` already keeps it in its session record
 * (`thu-automad/session`, `{ kind: 'grant', payload: { fingerprint, ... } }`),
 * written through the credentials seam's serialized read-modify-write. This
 * module reads that record, and when nothing is stored anywhere it generates a
 * fingerprint and writes it *there*, so both plugins converge on one device
 * identity instead of collecting one each.
 *
 * Precedence: the `THU_LEARN_FINGERPRINT` reference (an explicit override the
 * settings page can write) first, then the shared record, then a generated value.
 * @module dsh-thu-plugin/identity
 */

import { randomBytes } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { credentialKey, credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialRecord } from '@deepseek-ai/dsh-credentials'
import type { ThuOptions } from './config.ts'

/** Record `dsh-thu-automad` owns and this plugin shares. */
export const SHARED_SESSION_KEY = credentialKey('thu-automad', 'session')

/** Exactly what the school's chain generates: 16 random bytes, hex encoded. */
export const FINGERPRINT_PATTERN = /^[0-9a-f]{32}$/u

/** Where the fingerprint in hand came from. */
export type FingerprintSource = 'ref' | 'shared' | 'generated'

/** Resolved account. `fingerprint` is always present; the rest may be absent. */
export interface Identity {
  username?: string
  password?: string
  fingerprint: string
  fingerprintSource: FingerprintSource
}

/** Explicit override reference the settings page writes. */
const FINGERPRINT = credentialRef('THU_LEARN_FINGERPRINT')

/**
 * Generate a device fingerprint in the school's format.
 * @returns 32 lowercase hex characters.
 */
export function generateFingerprint(): string {
  return randomBytes(16).toString('hex')
}

/**
 * Read the fingerprint stored in the shared session record, if any.
 * @param ctx - context providing the credentials seam.
 * @returns the stored 32-hex fingerprint, or undefined when absent or malformed.
 */
export async function sharedFingerprint(ctx: Context): Promise<string | undefined> {
  const record = await ctx.credentials.readRecord(SHARED_SESSION_KEY)
  const payload = record?.kind === 'grant' ? record.payload : undefined
  if (typeof payload !== 'object' || payload === null) return undefined
  const value = (payload as Record<string, unknown>).fingerprint
  return typeof value === 'string' && FINGERPRINT_PATTERN.test(value) ? value : undefined
}

/**
 * Store a fingerprint in the shared session record, preserving the facts
 * `dsh-thu-automad` keeps beside it (renewal history, two-factor answers).
 *
 * `modifyRecord` serializes the read-modify-write across processes, and the
 * mutator re-checks the stored value: if another process won the race and wrote
 * a fingerprint first, that one is kept rather than overwritten.
 * @param ctx - context providing the credentials seam.
 * @param generate - produces a fingerprint when none is stored.
 * @returns the fingerprint now on record.
 */
export async function rememberFingerprint(
  ctx: Context,
  generate: () => string,
): Promise<string> {
  let chosen: string | undefined
  await ctx.credentials.modifyRecord(SHARED_SESSION_KEY, (current) => {
    const existing = current?.kind === 'grant' ? current.payload : undefined
    const payload = typeof existing === 'object' && existing !== null ? existing as Record<string, unknown> : {}
    const stored = typeof payload.fingerprint === 'string' && FINGERPRINT_PATTERN.test(payload.fingerprint)
      ? payload.fingerprint
      : undefined
    if (stored !== undefined) {
      chosen = stored
      return Promise.resolve(current)
    }
    chosen = generate()
    return Promise.resolve({ kind: 'grant', payload: { ...payload, fingerprint: chosen } } satisfies CredentialRecord)
  })
  if (chosen === undefined) throw new Error('dsh-thu-plugin: the credentials seam did not store a fingerprint')
  return chosen
}

/**
 * Resolve the account a Learn call signs in with.
 *
 * Reading is side-effect free until a fingerprint is genuinely needed: the
 * shared record is only written when neither an override nor a stored value
 * exists, which is exactly the first sign-in on this machine.
 * @param ctx - context providing the credentials seam.
 * @param options - validated options, carrying the configurable reference names.
 * @returns the resolved identity.
 */
export async function resolveIdentity(ctx: Context, options: ThuOptions): Promise<Identity> {
  const [username, password, override, shared] = await Promise.all([
    ctx.credentials.resolve(credentialRef(options.usernameRef)),
    ctx.credentials.resolve(credentialRef(options.passwordRef)),
    ctx.credentials.resolve(FINGERPRINT),
    sharedFingerprint(ctx),
  ])
  const explicit = textOrUndefined(override?.value)
  const fingerprint = explicit ?? shared ?? await rememberFingerprint(ctx, generateFingerprint)
  const user = textOrUndefined(username?.value)
  const pass = textOrUndefined(password?.value)
  return {
    ...(user === undefined ? {} : { username: user }),
    ...(pass === undefined ? {} : { password: pass }),
    fingerprint,
    fingerprintSource: explicit !== undefined ? 'ref' : shared !== undefined ? 'shared' : 'generated',
  }
}

/** Trim a resolved secret, treating blank as absent. */
function textOrUndefined(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}