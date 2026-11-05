/**
 * `thu_status`: report whether credentials and the external CLIs are present.
 *
 * This tool calls `describe`, never `resolve`. A status read must not put a
 * password, cookie, or token into the model-visible result.
 * @module dsh-thu-plugin/status
 */

import { access } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { ThuOptions } from './config.ts'
import { reservesCliPath } from './config.ts'
import { sharedFingerprint } from './identity.ts'
import { hasLearnSession } from './learn.ts'
import { findPaperCli, instsciConfigPath, readInstsciConfig } from './papers/fetch.ts'

/** Model-visible readiness for the three credentialed capabilities. */
export interface ThuStatus {
  learn: {
    credential: boolean
    session: boolean
    /** Device fingerprint found in the record shared with `dsh-thu-automad`. */
    sharedFingerprint: boolean
  }
  reserves: { cli: boolean; token: boolean }
  papers: {
    /** The CLI that will be spawned; absent when none is runnable. */
    cli?: string
    /** Whether an email the open-access lookup needs is saved. */
    email: boolean
    /** Institution named in the CLI's own config, when it names one. */
    school?: string
  }
}

const COOKIE = credentialRef('THU_LEARN_COOKIE')
const RESERVES_TOKEN = credentialRef('THU_RESERVES_TOKEN')

/**
 * Read presence facts only.
 * @param ctx - context providing the credentials seam.
 * @param options - validated plugin options.
 * @returns readiness flags. `learn.session` is true only after this process has opened a Learn session.
 */
export async function readStatus(ctx: Context, options: ThuOptions): Promise<ThuStatus> {
  const [username, password, cookie, token, shared] = await Promise.all([
    ctx.credentials.describe(credentialRef(options.usernameRef)),
    ctx.credentials.describe(credentialRef(options.passwordRef)),
    ctx.credentials.describe(COOKIE),
    ctx.credentials.describe(RESERVES_TOKEN),
    sharedFingerprint(ctx),
  ])
  const [papers, instsci] = await Promise.all([
    paperFacts(ctx, options),
    readInstsciConfig(instsciConfigPath()),
  ])
  const passwordLogin = username.configured && password.configured
  return {
    learn: {
      credential: passwordLogin || cookie.configured,
      session: hasLearnSession(),
      sharedFingerprint: shared !== undefined,
    },
    reserves: {
      cli: await exists(reservesCliPath(options)),
      token: token.configured || await exists(options.reservesTokenFile),
    },
    papers: {
      ...(papers.cli === null ? {} : { cli: papers.cli }),
      email: papers.email,
      ...(typeof instsci.school === 'string' && instsci.school.trim().length > 0 ? { school: instsci.school.trim() } : {}),
    },
  }
}

/** The CLI the paper tool would spawn, and whether an email is saved for it. */
async function paperFacts(ctx: Context, options: ThuOptions): Promise<{ cli: string | null; email: boolean }> {
  const [cli, email] = await Promise.all([
    findPaperCli(options),
    ctx.credentials.describe(credentialRef(options.paperEmailRef)),
  ])
  return { cli: cli ?? null, email: email.configured }
}

/** Whether a configured path is reachable. An empty path is not configured. */
async function exists(path: string): Promise<boolean> {
  if (path.length === 0) return false
  try {
    await access(path)
    return true
  } catch {
    // A missing file is a status fact, not a tool failure.
    return false
  }
}