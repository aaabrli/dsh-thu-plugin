/**
 * Tsinghua course-reserves downloader, wrapped as a subprocess.
 *
 * Upstream (`libthu/reserves-lib-tsinghua-downloader`, GPL-3.0) is never
 * vendored or imported here. It ships as a CLI the user installs from the
 * settings page, and this module only orchestrates it: validate the book URL,
 * check the token, spawn, collect, move the PDF into the workspace.
 *
 * Two upstream behaviours shape the design. The CLI reads `token.txt` from its
 * working directory and writes `<bookId>.pdf` there, so every call runs in a
 * private temp directory and the token never touches the workspace. And when
 * the token is missing or expired the CLI opens Chrome and blocks on `input()`,
 * which a tool call must never do — the token is therefore validated here
 * first (its JWT `exp`), and the child is spawned with stdin closed so any
 * unexpected prompt fails fast instead of waiting for a human.
 *
 * Upstream downloads a whole book: there is no chapter selection, and the PDF
 * is generated from the scans in memory. `--no-img` is passed so the scans are
 * not also written to disk.
 * @module dsh-thu-plugin/reserves
 */

import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, copyFile, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { ThuOptions } from './config.ts'
import { reservesCliPath } from './config.ts'
import { downloadRoot, freePath } from './download.ts'

/** Why a reserves download could not finish. Domain values, not exceptions. */
export type ReservesReason =
  | 'invalid-url'
  | 'cli-missing'
  | 'token-missing'
  | 'token-expired'
  | 'token-invalid'
  | 'rate-limited'
  | 'login-required'
  | 'exit-nonzero'
  | 'timeout'
  | 'cancelled'
  | 'no-output'

/** A failure the tool returns instead of throwing. */
export interface ReservesFailure {
  readonly ok: false
  readonly reason: ReservesReason
  readonly message: string
  /** Tail of the child's output, for the model and the user to read. */
  readonly log?: string
}

/** One finished book. `path` is local and absolute. */
export interface ReservesSuccess {
  readonly ok: true
  readonly bookId: string
  readonly book: string
  readonly path: string
  readonly bytes: number
  readonly pages: number
  readonly durationMs: number
}

/** Result of one download attempt. */
export type ReservesResult = ReservesSuccess | ReservesFailure

/** Arguments one download accepts. Token and paths come from config, never from the call. */
export interface ReservesArgs {
  /** Book detail URL. */
  readonly url: string
  /** JPEG quality 1–96; 96 leaves the scans untouched. */
  readonly quality?: number
}

const TOKEN = credentialRef('THU_RESERVES_TOKEN')

const BOOK_URL = /^https:\/\/ereserves\.lib\.tsinghua\.edu\.cn\/bookDetail\/([0-9A-Za-z]+)\/?$/u
const MAX_LOG = 64_000
const MAX_ERROR_TAIL = 2_000

/**
 * Pull the book id out of a book detail URL.
 * @param url - candidate URL.
 * @returns the id, or undefined when the URL is not a reserves book page.
 */
export function bookIdOf(url: string): string | undefined {
  return BOOK_URL.exec(url.trim())?.[1]
}

/**
 * Read the `exp` claim of a token without trusting its signature.
 *
 * The claim is only used to decide whether spawning would send the CLI down
 * its interactive login path; the server is still the authority on validity.
 * @param token - raw token.
 * @returns expiry in epoch seconds, or undefined when the token is not a JWT.
 */
export function tokenExpiry(token: string): number | undefined {
  const parts = token.trim().split('.')
  if (parts.length !== 3 || parts[1] === undefined || parts[1].length === 0) return undefined
  try {
    const payload: unknown = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    if (typeof payload !== 'object' || payload === null) return undefined
    const exp = (payload as { exp?: unknown }).exp
    return typeof exp === 'number' && Number.isFinite(exp) ? exp : undefined
  } catch {
    // A token without a readable payload is not usable, but only the server can
    // say why. Treat it as unreadable rather than expired.
    return undefined
  }
}

/** Read the token the same way the CLI would, without leaving it on disk. */
async function readToken(ctx: Context, options: ThuOptions): Promise<string | ReservesFailure> {
  const resolved = await ctx.credentials.resolve(TOKEN)
  const fromCredential = resolved?.value.trim()
  const token = fromCredential !== undefined && fromCredential.length > 0
    ? fromCredential
    : await readTokenFile(options.reservesTokenFile)
  if (token === undefined) {
    return {
      ok: false,
      reason: 'token-missing',
      message: 'Reserves needs THU_RESERVES_TOKEN (or reservesTokenFile). Log in to ereserves.lib.tsinghua.edu.cn, copy the License token from localStorage, and save it in Settings → Tsinghua tools.',
    }
  }
  const expiry = tokenExpiry(token)
  if (expiry === undefined) {
    return {
      ok: false,
      reason: 'token-invalid',
      message: 'The reserves token is not a readable JWT. Copy it again from localStorage.License on ereserves.lib.tsinghua.edu.cn.',
    }
  }
  if (Date.now() / 1_000 > expiry - 60) {
    return {
      ok: false,
      reason: 'token-expired',
      message: `The reserves token expired at ${new Date(expiry * 1_000).toISOString()}. Tokens last about an hour: log in again and save a fresh one.`,
    }
  }
  return token
}

/** Read a token file, treating "missing" and "blank" alike. */
async function readTokenFile(path: string): Promise<string | undefined> {
  if (path.length === 0) return undefined
  try {
    const value = (await readFile(path, 'utf8')).trim()
    return value.length > 0 ? value : undefined
  } catch {
    return undefined
  }
}

/** Whether the configured CLI path is present and executable. */
export async function cliReady(path: string): Promise<boolean> {
  if (path.length === 0) return false
  try {
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Everything the child printed, capped so a runaway log cannot exhaust memory. */
class Capture {
  readonly #chunks: string[] = []
  #size = 0

  append(chunk: string): void {
    if (this.#size >= MAX_LOG) return
    this.#chunks.push(chunk)
    this.#size += chunk.length
  }

  text(): string {
    return this.#chunks.join('')
  }

  tail(): string {
    const text = this.text().trim()
    return text.length > MAX_ERROR_TAIL ? `…${text.slice(-MAX_ERROR_TAIL)}` : text
  }
}

/** Map the CLI's own words onto a reason the model can act on. */
function reasonOfOutput(log: string): ReservesReason {
  if (/token need to renew|please renew your token|cookie required/iu.test(log)) return 'token-expired'
  if (/rate limit|too many requests|429/iu.test(log)) return 'rate-limited'
  if (/please login in the browser|webdriver|selenium/iu.test(log)) return 'login-required'
  return 'exit-nonzero'
}

/** The message a human needs for each reason the CLI can end in. */
function messageOfOutput(reason: ReservesReason): string {
  switch (reason) {
    case 'token-expired':
      return 'The reserves token was rejected or expired. Save a fresh token in Settings → Tsinghua tools and try again.'
    case 'rate-limited':
      return 'The reserves platform rate-limited this machine. Wait a few minutes before retrying; the request gap is already at the configured floor.'
    case 'login-required':
      return 'The CLI tried to open a browser to log in. A tool call cannot answer that prompt: save a fresh THU_RESERVES_TOKEN and retry.'
    default:
      return 'The reserves CLI exited with an error. Its output tail is on `log`.'
  }
}

/**
 * Download one book.
 * @param ctx - context providing the credentials seam.
 * @param options - validated plugin options.
 * @param cwd - session working directory the download root resolves under.
 * @param args - book URL and optional quality.
 * @param signal - cancellation.
 * @returns the finished PDF, or a failure the tool returns as-is.
 */
export async function downloadBook(
  ctx: Context,
  options: ThuOptions,
  cwd: string,
  args: ReservesArgs,
  signal: AbortSignal,
): Promise<ReservesResult> {
  const bookId = bookIdOf(args.url)
  if (bookId === undefined) {
    return {
      ok: false,
      reason: 'invalid-url',
      message: 'Pass a book detail URL such as https://ereserves.lib.tsinghua.edu.cn/bookDetail/<id>.',
    }
  }
  if (!await cliReady(reservesCliPath(options))) {
    return {
      ok: false,
      reason: 'cli-missing',
      message: `The reserves CLI is not installed (looked at ${reservesCliPath(options)}). Use the download button in Settings → Tsinghua tools, or set reservesCli.`,
    }
  }
  const token = await readToken(ctx, options)
  if (typeof token !== 'string') return token
  if (signal.aborted) return { ok: false, reason: 'cancelled', message: 'The download was cancelled.' }

  const runDir = await mkdtemp(join(tmpdir(), 'dsh-thu-reserves-'))
  const startedAt = Date.now()
  const capture = new Capture()
  try {
    await writeFile(join(runDir, 'token.txt'), `${token}\n`, { mode: 0o600 })
    const interval = (Math.max(1_000, options.reservesDelayMs) / 1_000).toFixed(1)
    const argv = [
      '-u', args.url,
      '-e',
      '-i', interval,
      '-c', '1',
      '--no-img',
      ...(args.quality !== undefined ? ['-q', String(args.quality)] : []),
    ]
    const exit = await run(reservesCliPath(options), argv, runDir, options.reservesTimeoutMs, signal, capture)
    const log = capture.text()

    if (exit.cancelled) return { ok: false, reason: 'cancelled', message: 'The download was cancelled.', log: capture.tail() }
    if (exit.timedOut) {
      return {
        ok: false,
        reason: 'timeout',
        message: `The reserves CLI ran longer than ${String(Math.round(options.reservesTimeoutMs / 60_000))} minutes and was stopped.`,
        log: capture.tail(),
      }
    }
    if (exit.code !== 0) {
      const reason = reasonOfOutput(log)
      return { ok: false, reason, message: messageOfOutput(reason), log: capture.tail() }
    }

    const produced = join(runDir, `${bookId}.pdf`)
    let bytes: number
    try {
      bytes = (await stat(produced)).size
    } catch {
      return {
        ok: false,
        reason: 'no-output',
        message: `The CLI finished without writing ${bookId}.pdf. Its output tail is on \`log\`.`,
        log: capture.tail(),
      }
    }

    const targetDir = join(downloadRoot(cwd, options.downloadDir), 'reserves')
    await mkdir(targetDir, { recursive: true })
    const target = await freePath(targetDir, `${bookId}.pdf`)
    try {
      await rename(produced, target)
    } catch {
      // A temp dir on another filesystem cannot be renamed across; copy instead.
      await copyFile(produced, target)
    }
    return {
      ok: true,
      bookId,
      book: bookNameOf(log) ?? bookId,
      path: target,
      bytes,
      pages: pagesOf(log),
      durationMs: Date.now() - startedAt,
    }
  } finally {
    await rm(runDir, { recursive: true, force: true })
  }
}

/** Book title from the CLI's own line, when it printed one. */
function bookNameOf(log: string): string | undefined {
  return /^Bookname:\s*(.+)$/mu.exec(log)?.[1]?.trim()
}

/** Page count from the CLI's own summary line. */
function pagesOf(log: string): number {
  const match = /Clawed (\d+) pages/iu.exec(log)
  return match?.[1] === undefined ? 0 : Number.parseInt(match[1], 10)
}

interface ExitFacts {
  readonly code: number | null
  readonly timedOut: boolean
  readonly cancelled: boolean
}

/** Spawn the CLI, collect its output, and honour cancellation and a deadline. */
async function run(
  cli: string,
  argv: readonly string[],
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal,
  capture: Capture,
): Promise<ExitFacts> {
  return new Promise((resolve, reject) => {
    const child = spawn(cli, [...argv], { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let timedOut = false
    let cancelled = false
    const kill = (): void => {
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 5_000).unref()
    }
    const timer = setTimeout(() => {
      timedOut = true
      kill()
    }, timeoutMs)
    const onAbort = (): void => {
      cancelled = true
      kill()
    }
    signal.addEventListener('abort', onAbort, { once: true })
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => capture.append(chunk))
    child.stderr.on('data', (chunk: string) => capture.append(chunk))
    child.once('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      reject(error.code === 'ENOENT'
        ? Object.assign(new Error(`reserves CLI not runnable: ${cli}`), { code: 'ENOENT' })
        : error)
    })
    child.once('close', (code: number | null) => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      resolve({ code, timedOut, cancelled })
    })
  })
}