/**
 * Paper acquisition through the local `instsci` CLI.
 *
 * The CLI owns every way of reaching a paper — open-access lookup, arXiv,
 * institution gateways, publisher flows — and one of those ways opens a visible
 * browser window that a tool call cannot drive. So this module never
 * reimplements a route: it runs the CLI once per paper, reads the single
 * machine-readable report the CLI prints, validates the bytes it saved, and
 * moves the PDF under the workspace.
 * @module dsh-thu-plugin/papers/fetch
 */

import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, copyFile, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { ThuOptions } from '../config.ts'
import { downloadRoot, freePath, safeFileName } from '../download.ts'

/** Everything that can stop a fetch without throwing. */
export type PaperReason =
  | 'cli-missing'
  | 'missing-credential'
  | 'timeout'
  | 'cancelled'
  | 'exit-nonzero'
  | 'unparseable-output'
  | 'no-pdf'
  | 'invalid-pdf'

/** A fetch that ended in a domain outcome. */
export interface PaperFailure {
  readonly ok: false
  readonly reason: PaperReason
  readonly message: string
  /** CLI output tail, when the CLI said something useful. */
  readonly log?: string
}

/** A PDF that is now in the workspace. */
export interface PaperSuccess {
  readonly ok: true
  readonly identifier: string
  readonly doi?: string
  readonly arxivId?: string
  readonly title: string
  /** The CLI's own classification: success, partial, blocked, … */
  readonly status: string
  readonly quality: string
  readonly source: string
  readonly path: string
  readonly bytes: number
  readonly durationMs: number
}

/** Result of one fetch. */
export type PaperResult = PaperSuccess | PaperFailure

/** Arguments one fetch accepts. */
export interface PaperFetchArgs {
  readonly identifier: string
  /** Replace an existing file of the same name instead of adding `-1`. */
  readonly overwrite?: boolean
}

/**
 * Test seams. Production passes none: the CLI has no environment override for
 * its config path, so checks point `configPath` at a scratch file and `env` at
 * a controlled PATH.
 */
export interface PaperSeams {
  readonly configPath?: string
  readonly env?: NodeJS.ProcessEnv
  readonly cli?: string
  /** Origin for the arXiv PDF route; tests point it at a local server. */
  readonly arxivOrigin?: string
}

/** Output kept per child, capped so a runaway log cannot exhaust memory. */
const MAX_LOG = 64_000
/** Output kept in an error result. */
const MAX_TAIL = 2_000
/** arXiv serves PDFs to anyone under this origin, so the direct route needs no gateway. */
const ARXIV_ORIGIN = 'https://arxiv.org'
/** One HTTP response, not a browser window: the 20-minute paper ceiling does not apply. */
const ARXIV_TIMEOUT_MS = 120_000
/** A reset connection is often the proxy blipping; one retry covers it without hiding a real block. */
const ARXIV_ATTEMPTS = 2
/** Pause before that retry, so a flapping tunnel has a moment to come back. */
const ARXIV_RETRY_MS = 1_000
/** Bytes every plausible PDF must exceed, mirroring the CLI's own gate. */
const MIN_PDF_BYTES = 5_000
/** A `%%EOF` further than this from the end means a truncated download. */
const EOF_WINDOW = 8_192
const PDF_MAGIC = '%PDF-'
const EOF_MARKER = '%%EOF'

/** Where the CLI keeps its own configuration. */
export function instsciConfigPath(): string {
  return join(homedir(), '.instsci', 'config.json')
}

/** Whether a path is present and executable. */
async function isExecutable(path: string): Promise<boolean> {
  if (path.length === 0) return false
  try {
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Find a program on PATH.
 * @param name - program name without a directory.
 * @param env - environment to read PATH from.
 * @returns the first executable match.
 */
export async function findOnPath(name: string, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  const names = process.platform === 'win32' ? [`${name}.exe`, name] : [name]
  for (const directory of (env.PATH ?? '').split(delimiter)) {
    if (directory.length === 0) continue
    for (const candidate of names) {
      const full = join(directory, candidate)
      if (await isExecutable(full)) return full
    }
  }
  return undefined
}

/**
 * Resolve the CLI: the configured path, then the installer's own location, then
 * PATH. A configured path that does not exist is reported as missing rather
 * than silently falling through to a different binary.
 * @param options - validated plugin options.
 * @param env - environment to read PATH from.
 * @returns the runnable CLI, or undefined.
 */
export async function findPaperCli(options: ThuOptions, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  const configured = options.paperCli.trim()
  if (configured.length > 0) return await isExecutable(configured) ? configured : undefined
  const local = join(homedir(), '.local', 'bin', process.platform === 'win32' ? 'instsci.exe' : 'instsci')
  if (await isExecutable(local)) return local
  return await findOnPath('instsci', env)
}

/** The places a missing CLI was looked for, for the failure message. */
function cliHint(options: ThuOptions): string {
  const configured = options.paperCli.trim()
  return configured.length > 0
    ? `paperCli is set to ${configured}, which is not executable`
    : `looked at ~/.local/bin/instsci and PATH`
}

/** Read the CLI's config as plain data; a broken file reads as empty. */
export async function readInstsciConfig(path: string): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

/**
 * Make sure the CLI has the email it prompts for and an institution to use.
 *
 * The CLI asks for an email on stdin when it has none, which a tool call cannot
 * answer, so the address is written here first. The institution is only filled
 * in when the file does not name one, so a user choice already on disk wins.
 * @param ctx - context providing the credentials seam.
 * @param options - validated plugin options.
 * @param configPath - the CLI config file to reconcile.
 * @returns ok, or the missing-credential failure.
 */
async function syncIdentity(
  ctx: Context,
  options: ThuOptions,
  configPath: string,
): Promise<{ ok: true } | PaperFailure> {
  const existing = await readInstsciConfig(configPath)
  const resolved = await ctx.credentials.resolve(credentialRef(options.paperEmailRef))
  const saved = typeof existing.email === 'string' ? existing.email.trim() : ''
  const email = (resolved?.value.trim() ?? '') || saved
  if (email.length === 0) {
    return {
      ok: false,
      reason: 'missing-credential',
      message: `Paper fetching needs an email address: the open-access lookup sends it with every request. Save ${options.paperEmailRef} in Settings → Tsinghua tools.`,
    }
  }
  const patch: Record<string, unknown> = {}
  if (saved !== email) patch.email = email
  // Four names, two meanings: `school` is looked up in the Chinese campus
  // gateway table, while publisher login pages and the CARSI list are matched
  // against the English name. A value already on disk is never replaced.
  const fill = (key: string, wanted: string): void => {
    const current = typeof existing[key] === 'string' ? (existing[key] as string).trim() : ''
    if (current.length === 0 && wanted.trim().length > 0) patch[key] = wanted.trim()
  }
  fill('school', options.paperSchool)
  fill('institution_name_zh', options.paperSchool)
  fill('institution_name_en', options.paperSchoolEn)
  fill('carsi_idp_name', options.paperSchoolEn)
  if (Object.keys(patch).length > 0) {
    await mkdir(dirname(configPath), { recursive: true })
    await writeFile(configPath, `${JSON.stringify({ ...existing, ...patch }, null, 2)}\n`, { mode: 0o600 })
  }
  return { ok: true }
}

/** Facts about one finished child process. */
export interface SpawnResult {
  readonly code: number | null
  readonly timedOut: boolean
  readonly cancelled: boolean
  /** stdout and stderr interleaved, capped at `MAX_LOG`. */
  readonly text: string
}

/**
 * Run a child to completion, honouring cancellation and a deadline.
 * @param cli - executable.
 * @param argv - arguments.
 * @param options - working directory, environment, timeout, cancellation.
 * @returns exit facts; never rejects for a non-zero exit.
 */
export async function spawnWithDeadline(
  cli: string,
  argv: readonly string[],
  options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv; readonly timeoutMs: number; readonly signal: AbortSignal },
): Promise<SpawnResult> {
  return await new Promise<SpawnResult>((resolve, reject) => {
    const child = spawn(cli, [...argv], { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let text = ''
    let timedOut = false
    let cancelled = false
    const capture = (chunk: string): void => {
      if (text.length < MAX_LOG) text += chunk
    }
    const kill = (): void => {
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 5_000).unref()
    }
    const timer = setTimeout(() => {
      timedOut = true
      kill()
    }, options.timeoutMs)
    const onAbort = (): void => {
      cancelled = true
      kill()
    }
    options.signal.addEventListener('abort', onAbort, { once: true })
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', capture)
    child.stderr.on('data', capture)
    child.once('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      options.signal.removeEventListener('abort', onAbort)
      reject(error)
    })
    child.once('close', (code: number | null) => {
      clearTimeout(timer)
      options.signal.removeEventListener('abort', onAbort)
      resolve({ code, timedOut, cancelled, text })
    })
  })
}

/**
 * Pull the report object out of the CLI's output.
 *
 * The CLI prints a banner line, then the JSON, then two summary lines, and the
 * JSON is folded when the caller's terminal is narrow. So this takes the first
 * line that opens an object through the last line that closes one, and falls
 * back to scanning for the balanced object.
 * @param text - interleaved stdout and stderr.
 * @returns the JSON text, or undefined.
 */
export function extractJson(text: string): string | undefined {
  const lines = text.split(/\r?\n/u)
  const start = lines.findIndex(line => line.trimStart().startsWith('{'))
  if (start !== -1) {
    for (let end = lines.length - 1; end > start; end -= 1) {
      const line = lines[end]
      if (line === undefined || !line.trimEnd().endsWith('}')) continue
      const candidate = lines.slice(start, end + 1).join('\n')
      try {
        JSON.parse(candidate)
        return candidate
      } catch {
        // Keep walking up: a bracket inside the text may have looked like an end.
      }
    }
  }
  return balanced(text)
}

/** Scan for the first balanced `{…}` run, ignoring braces inside strings. */
function balanced(text: string): string | undefined {
  const start = text.indexOf('{')
  if (start === -1) return undefined
  let depth = 0
  let quoted = false
  let escaped = false
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]
    if (quoted) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') quoted = false
      continue
    }
    if (char === '"') quoted = true
    else if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) {
        const candidate = text.slice(start, index + 1)
        try {
          JSON.parse(candidate)
          return candidate
        } catch {
          return undefined
        }
      }
    }
  }
  return undefined
}

/** Why a payload is not a usable PDF, in the order the CLI reports it. */
export type PdfProblem =
  | 'empty'
  | 'html_response'
  | 'too_small'
  | 'missing_pdf_header'
  | 'corrupt_pdf_header'
  | 'early_eof_with_trailing_payload'

/**
 * Whether bytes look like a whole PDF.
 *
 * A download that is really an HTML login page, a truncated transfer, or an
 * error document saved under a `.pdf` name all pass a "did a file appear" test
 * and then fail when someone opens them, so the bytes are checked here.
 * @param bytes - the file contents.
 * @returns the problem, or undefined when the bytes are plausible.
 */
export function pdfProblem(bytes: Uint8Array): PdfProblem | undefined {
  const length = bytes.length
  if (length === 0) return 'empty'
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(512, length))).replace(/^\s+/u, '').toLowerCase()
  if (['<!doctype html', '<html', '<head', '<body'].some(tag => head.startsWith(tag))) return 'html_response'
  if (length <= MIN_PDF_BYTES) return 'too_small'
  if (!startsWithText(bytes, PDF_MAGIC)) return 'missing_pdf_header'
  const opening = bytes.subarray(0, Math.min(64, length))
  for (let index = 0; index + 2 < opening.length; index += 1) {
    if (opening[index] === 0xef && opening[index + 1] === 0xbf && opening[index + 2] === 0xbd) return 'corrupt_pdf_header'
  }
  const eof = lastIndexOfText(bytes, EOF_MARKER)
  if (eof !== -1 && eof < Math.max(0, length - EOF_WINDOW)) return 'early_eof_with_trailing_payload'
  return undefined
}

/** Whether the buffer opens with the given ASCII text. */
function startsWithText(bytes: Uint8Array, text: string): boolean {
  if (bytes.length < text.length) return false
  for (let index = 0; index < text.length; index += 1) {
    if (bytes[index] !== text.charCodeAt(index)) return false
  }
  return true
}

/** Offset of the last occurrence of the given ASCII text, or -1. */
function lastIndexOfText(bytes: Uint8Array, text: string): number {
  const first = text.charCodeAt(0)
  for (let index = bytes.length - text.length; index >= 0; index -= 1) {
    if (bytes[index] !== first) continue
    let matched = true
    for (let offset = 1; offset < text.length; offset += 1) {
      if (bytes[index + offset] !== text.charCodeAt(offset)) {
        matched = false
        break
      }
    }
    if (matched) return index
  }
  return -1
}

/** The arXiv identifier an identifier names, when it names one. */
export function arxivOf(identifier: string): string | null {
  const match = /(?:arxiv\.org\/(?:abs|pdf)\/|^arxiv:)(\d{4}\.\d{4,5})(?:v\d+)?/iu.exec(identifier.trim())
    ?? /^(\d{4}\.\d{4,5})(?:v\d+)?$/u.exec(identifier.trim())
  return match?.[1] ?? null
}

/**
 * The file name a paper is saved under: its DOI, else its arXiv id.
 * @param doi - the paper's DOI, when it has one.
 * @param arxivId - the arXiv identifier, when the name needs to fall back.
 * @returns a safe `.pdf` file name.
 */
export function paperFileName(doi: string | null, arxivId: string | null): string {
  const named = (doi ?? '').trim() || (arxivId ?? '').trim()
  const base = named.length > 0 ? named : 'paper'
  return `${safeFileName(base.replace(/[^\w\-.]/gu, '_'))}.pdf`
}

let queue: Promise<unknown> = Promise.resolve()

/**
 * Run paper work one job at a time.
 *
 * A fetch can open a visible browser window; two at once would race for the
 * same profile and for the same file name, and the CLI's own cache is not
 * written concurrently.
 * @param work - the job.
 * @returns the job's result.
 */
export function serialize<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(work, work)
  queue = next.then(() => undefined, () => undefined)
  return next
}

/** Trim CLI output for an error result. */
function tailOf(text: string): string {
  const trimmed = text.trim()
  return trimmed.length > MAX_TAIL ? `…${trimmed.slice(-MAX_TAIL)}` : trimmed
}

/** Read a field of the report as a string. */
function textOf(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Fetch one paper into the workspace.
 * @param ctx - context providing the credentials seam.
 * @param options - validated plugin options.
 * @param cwd - session working directory the download root resolves under.
 * @param args - identifier and overwrite.
 * @param signal - cancellation.
 * @param seams - test seams; omit in production.
 * @returns the saved PDF, or a failure the tool returns as-is.
 */
/**
 * Describe a failed `fetch` with the socket-level cause, when there is one.
 *
 * Node's own message is just "fetch failed", which tells a user nothing about
 * whether they lost DNS, TLS, or a proxy. The cause carries the code that does.
 * @param error - whatever `fetch` threw.
 * @returns a short sentence fragment for the tool's `message`.
 */
function describeFetchError(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const cause = (error as { cause?: { code?: unknown } }).cause
  const code = typeof cause?.code === 'string' ? cause.code : undefined
  return code === undefined ? error.message : `${error.message} (${code})`
}

/**
 * Wait, but wake up immediately when the tool is cancelled.
 * @param ms - how long to wait.
 * @param signal - cancellation.
 * @returns a promise that always resolves.
 */
async function pause(ms: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
  })
}

/**
 * The folder paper PDFs land in.
 *
 * Empty `paperDir` keeps the historical layout under the workspace. A relative
 * value is read from the workspace, so `papers` and `thu-downloads/papers` both
 * mean a folder inside the conversation's workspace; an absolute value (or
 * `~/…`) is used as written, for people who keep a literature folder elsewhere.
 * @param cwd - the session's working directory.
 * @param options - plugin options.
 * @returns an absolute directory path, not yet created.
 */
export function paperDirectory(cwd: string, options: ThuOptions): string {
  const configured = options.paperDir.trim()
  if (configured.length === 0) return join(downloadRoot(cwd, options.downloadDir), 'papers')
  const expanded = configured === '~'
    ? homedir()
    : configured.startsWith('~/') ? join(homedir(), configured.slice(2)) : configured
  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded)
}

/**
 * Download an arXiv PDF directly from arXiv.
 *
 * The CLI parses only DOIs and URLs, and an arXiv URL still sends it down the
 * campus-gateway path, so neither identifier form yields a PDF for an arXiv
 * paper. arXiv serves the PDF itself to anyone, which makes this the single
 * route worth taking without the CLI. The bytes pass the same plausibility gate
 * as the CLI's own output, and the file lands next to the CLI's files.
 * @param options - plugin options.
 * @param cwd - workspace root.
 * @param args - fetch arguments.
 * @param signal - cancellation.
 * @param seams - test seam for the origin.
 * @param arxiv - the arXiv id parsed from the identifier.
 * @returns the saved paper, or a typed failure.
 */
async function fetchArxivPdf(
  options: ThuOptions,
  cwd: string,
  args: PaperFetchArgs,
  signal: AbortSignal,
  seams: PaperSeams,
  arxiv: string,
): Promise<PaperResult> {
  const startedAt = Date.now()
  const pdfUrl = new URL(`/pdf/${arxiv}`, seams.arxivOrigin ?? ARXIV_ORIGIN).href
  let bytes: Uint8Array | undefined
  let failure = ''
  for (let attempt = 0; attempt < ARXIV_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await pause(ARXIV_RETRY_MS, signal)
    if (signal.aborted) return { ok: false, reason: 'cancelled', message: 'The fetch was cancelled.' }
    try {
      const response = await fetch(pdfUrl, {
        redirect: 'follow',
        signal: AbortSignal.any([
          signal,
          AbortSignal.timeout(Math.min(options.paperTimeoutMs, ARXIV_TIMEOUT_MS)),
        ]),
      })
      if (!response.ok) {
        return {
          ok: false,
          reason: 'exit-nonzero',
          message: `arXiv answered HTTP ${String(response.status)} for ${pdfUrl}.`,
        }
      }
      bytes = new Uint8Array(await response.arrayBuffer())
      break
    } catch (error) {
      if (signal.aborted) return { ok: false, reason: 'cancelled', message: 'The fetch was cancelled.' }
      failure = describeFetchError(error)
    }
  }
  if (bytes === undefined) {
    return {
      ok: false,
      reason: 'no-pdf',
      message: `Could not download ${pdfUrl} (${failure}). Check this machine's network or proxy, then retry.`,
    }
  }
  const problem = pdfProblem(bytes)
  if (problem !== undefined) {
    return {
      ok: false,
      reason: 'invalid-pdf',
      message: `arXiv answered with ${String(bytes.byteLength)} bytes that are not a usable PDF (${problem}).`,
    }
  }
  const directory = paperDirectory(cwd, options)
  await mkdir(directory, { recursive: true })
  const name = paperFileName(null, arxiv)
  const destination = args.overwrite === true ? join(directory, name) : await freePath(directory, name)
  await writeFile(destination, bytes)
  return {
    ok: true,
    identifier: args.identifier,
    arxivId: arxiv,
    title: `arXiv ${arxiv}`,
    status: 'success',
    quality: 'pdf_only',
    source: 'arxiv',
    path: destination,
    bytes: bytes.byteLength,
    durationMs: Date.now() - startedAt,
  }
}

export async function fetchPaper(
  ctx: Context,
  options: ThuOptions,
  cwd: string,
  args: PaperFetchArgs,
  signal: AbortSignal,
  seams: PaperSeams = {},
): Promise<PaperResult> {
  // An arXiv id goes straight to arXiv: the CLI cannot resolve a bare id, and
  // its URL route ends at the campus gateway even for a public PDF.
  const arxiv = arxivOf(args.identifier)
  if (arxiv !== null) return await fetchArxivPdf(options, cwd, args, signal, seams, arxiv)
  const env = seams.env ?? process.env
  const cli = seams.cli ?? await findPaperCli(options, env)
  if (cli === undefined) {
    return {
      ok: false,
      reason: 'cli-missing',
      message: `The paper CLI is not installed (${cliHint(options)}). Use the install button in Settings → Tsinghua tools, or set paperCli.`,
    }
  }
  const configPath = seams.configPath ?? instsciConfigPath()
  const identity = await syncIdentity(ctx, options, configPath)
  if (!identity.ok) return identity
  if (signal.aborted) return { ok: false, reason: 'cancelled', message: 'The fetch was cancelled.' }

  return await serialize(async () => {
    const startedAt = Date.now()
    const runDir = await mkdtemp(join(tmpdir(), 'dsh-thu-papers-'))
    const outputDir = join(runDir, 'papers')
    try {
      await mkdir(outputDir, { recursive: true })
      const exit = await spawnWithDeadline(cli, ['fetch', args.identifier, '--format', 'json', '--output', outputDir], {
        cwd: runDir,
        // A narrow terminal makes the CLI fold its JSON across lines.
        env: {
          ...env,
          COLUMNS: '100000',
          NO_COLOR: '1',
          // The CLI prepares a browser cache at import time and, without this,
          // tries to create it inside site-packages: read-only on some installs,
          // and an odd place for a downloaded Chromium either way.
          CLOAKBROWSER_CACHE_DIR: join(homedir(), '.instsci', 'browsers'),
        },
        timeoutMs: options.paperTimeoutMs,
        signal,
      })
      if (exit.cancelled) return { ok: false, reason: 'cancelled', message: 'The fetch was cancelled.', log: tailOf(exit.text) }
      if (exit.timedOut) {
        return {
          ok: false,
          reason: 'timeout',
          message: `The paper CLI ran longer than ${String(Math.round(options.paperTimeoutMs / 60_000))} minutes and was stopped. Publisher routes open a browser window and wait for a login, so raise paperTimeoutMs if a login was in progress.`,
          log: tailOf(exit.text),
        }
      }
      if (exit.code !== 0) {
        if (/enter your email|email address/iu.test(exit.text)) {
          return {
            ok: false,
            reason: 'missing-credential',
            message: `The paper CLI asked for an email address on stdin, which a tool call cannot answer. Save ${options.paperEmailRef} in Settings → Tsinghua tools and retry.`,
            log: tailOf(exit.text),
          }
        }
        return {
          ok: false,
          reason: 'exit-nonzero',
          message: `The paper CLI exited with code ${String(exit.code)}. Its output tail is on \`log\`.`,
          log: tailOf(exit.text),
        }
      }

      const raw = extractJson(exit.text)
      if (raw === undefined) {
        return {
          ok: false,
          reason: 'unparseable-output',
          message: 'The paper CLI finished without printing a readable report. Its output tail is on `log`.',
          log: tailOf(exit.text),
        }
      }
      let report: Record<string, unknown>
      try {
        const parsed: unknown = JSON.parse(raw)
        report = typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {}
      } catch {
        return {
          ok: false,
          reason: 'unparseable-output',
          message: 'The paper CLI printed a report that is not valid JSON. Its output tail is on `log`.',
          log: tailOf(exit.text),
        }
      }

      const paper = typeof report.paper === 'object' && report.paper !== null ? report.paper as Record<string, unknown> : {}
      const produced = textOf(paper, 'pdf_path')
      const status = textOf(report, 'status')
      const quality = textOf(report, 'quality')
      const source = textOf(paper, 'source')
      const title = textOf(paper, 'title')
      const doi = textOf(paper, 'doi')
      const arxivId = arxivOf(args.identifier)
      if (produced.length === 0) {
        const next = typeof report.next_action === 'object' && report.next_action !== null
          ? report.next_action as Record<string, unknown>
          : {}
        const hint = textOf(next, 'message') || (textOf(next, 'command') ? `Next step: ${textOf(next, 'command')}` : '')
        const reason = textOf(report, 'reason')
        return {
          ok: false,
          reason: 'no-pdf',
          message: `The CLI fetched no PDF${status.length > 0 ? ` (status "${status}")` : ''}${reason.length > 0 ? `: ${reason}` : ''}.${hint.length > 0 ? ` ${hint}` : ''}`,
          log: tailOf(exit.text),
        }
      }

      let bytes: number
      try {
        bytes = (await stat(produced)).size
      } catch {
        return {
          ok: false,
          reason: 'no-pdf',
          message: `The CLI reported a PDF at ${produced}, but no file is there.`,
          log: tailOf(exit.text),
        }
      }
      let problem: PdfProblem | undefined
      try {
        problem = pdfProblem(await readFile(produced))
      } catch {
        return { ok: false, reason: 'no-pdf', message: `The PDF the CLI saved at ${produced} could not be read.`, log: tailOf(exit.text) }
      }
      if (problem !== undefined) {
        return {
          ok: false,
          reason: 'invalid-pdf',
          message: `The CLI saved a ${String(bytes)}-byte file that is not a usable PDF (${problem}). The access route probably returned a login page or a truncated transfer.`,
          log: tailOf(exit.text),
        }
      }

      const targetDir = paperDirectory(cwd, options)
      await mkdir(targetDir, { recursive: true })
      const name = paperFileName(doi.length > 0 ? doi : null, arxivId)
      const target = args.overwrite === true ? join(targetDir, name) : await freePath(targetDir, name)
      try {
        await rename(produced, target)
      } catch {
        // A temp dir on another filesystem cannot be renamed across; copy instead.
        await copyFile(produced, target)
      }
      return {
        ok: true,
        identifier: args.identifier,
        ...(doi.length > 0 ? { doi } : {}),
        ...(arxivId === null ? {} : { arxivId }),
        title,
        status,
        quality,
        source,
        path: target,
        bytes,
        durationMs: Date.now() - startedAt,
      }
    } finally {
      await rm(runDir, { recursive: true, force: true })
    }
  })
}