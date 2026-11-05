/**
 * Seafile share-link client for cloud.tsinghua.edu.cn.
 *
 * Only the anonymous, public share API is used (`/api/v2.1/share-links/...`),
 * so this needs no account and no cookie: possession of the share URL is the
 * whole authorization. That is also the boundary — encrypted links are refused
 * rather than cracked.
 */

import { downloadToFile, resolveInside, runPool, safeFileName } from './download.ts'
import { nameMatcher } from './pattern.ts'

/** Origin of the Tsinghua Seafile instance. */
const CLOUD_ORIGIN = 'https://cloud.tsinghua.edu.cn'

/**
 * Request options shared by the share-link calls. `origin` exists so a check can
 * point the client at a local server; production calls never pass it.
 */
export interface CloudRequestOptions {
  readonly timeoutMs: number
  readonly signal: AbortSignal
  readonly origin?: string
}

/** Why a cloud operation could not proceed. Domain values, not exceptions. */
export type CloudReason =
  | 'invalid-url'
  | 'not-found'
  | 'locked'
  | 'network'
  | 'timeout'
  | 'http-error'
  | 'empty-directory'

/** One entry of a shared directory. */
export interface CloudEntry {
  readonly name: string
  readonly path: string
  readonly type: 'file' | 'dir'
  readonly size: number
}

/** A share location: which link, and where inside it. */
export interface ShareTarget {
  readonly shareKey: string
  readonly path: string
}

/** A failure carrying a domain reason the tools can return instead of throwing. */
export class CloudError extends Error {
  constructor(
    readonly reason: CloudReason,
    message: string,
  ) {
    super(message)
    this.name = 'CloudError'
  }
}

const SHARE_KEY = /^[A-Za-z0-9]{8,64}$/u

/**
 * Accept a full share URL, a URL with a `?p=` path, or a bare share key.
 * @param input - user-supplied link or key.
 * @param path - explicit `path` argument, which wins over one embedded in the URL.
 * @returns the share key and the directory path to operate on.
 */
export function parseShareTarget(input: string, path?: string): ShareTarget {
  const text = input.trim()
  if (text === '') throw new CloudError('invalid-url', 'share link is empty')

  if (SHARE_KEY.test(text)) {
    return { shareKey: text, path: normalizePath(path ?? '/') }
  }

  let url: URL
  try {
    url = new URL(text)
  } catch {
    throw new CloudError('invalid-url', `not a share link: ${text}`)
  }
  if (url.host !== 'cloud.tsinghua.edu.cn') {
    throw new CloudError('invalid-url', `expected a cloud.tsinghua.edu.cn link, got ${url.host || text}`)
  }

  const segments = url.pathname.split('/').filter(segment => segment !== '')
  const marker = segments[0]
  if (marker !== 'd' || segments[1] === undefined) {
    throw new CloudError('invalid-url', 'only public share links (/d/<key>) are supported')
  }
  const shareKey = segments[1]
  if (!SHARE_KEY.test(shareKey)) throw new CloudError('invalid-url', `malformed share key: ${shareKey}`)

  const embedded = url.searchParams.get('p') ?? `/${segments.slice(2).join('/')}`
  return { shareKey, path: normalizePath(path ?? embedded) }
}

/**
 * Normalize a directory path to absolute, slash-separated, no trailing slash
 * (except the root).
 * @param value - raw path.
 * @returns the normalized path.
 */
export function normalizePath(value: string): string {
  const collapsed = value.replaceAll('\\', '/').split('/').filter(segment => segment !== '' && segment !== '.').join('/')
  return collapsed === '' ? '/' : `/${collapsed}`
}

/** Join a directory path and a child name. */
export function joinPath(dir: string, name: string): string {
  return dir === '/' ? `/${name}` : `${dir}/${name}`
}

/**
 * Fetch with a timeout fused onto the caller's cancellation signal.
 * @param url - target URL.
 * @param signal - caller cancellation.
 * @param timeoutMs - per-request deadline.
 * @returns the response.
 */
async function request(url: string, signal: AbortSignal, timeoutMs: number): Promise<Response> {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
  try {
    return await fetch(url, { signal: deadline, redirect: 'follow' })
  } catch (error) {
    if (signal.aborted) throw error
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new CloudError('timeout', `request timed out after ${timeoutMs}ms: ${url}`)
    }
    throw new CloudError('network', `network error: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Map an HTTP status to a domain reason, so callers never guess.
 * @param status - response status.
 * @param url - URL that failed, for the message.
 */
function statusError(status: number, url: string): CloudError {
  if (status === 404) return new CloudError('not-found', `shared link not found or path missing: ${url}`)
  if (status === 401 || status === 403) return new CloudError('locked', 'shared link is password-protected or no longer public')
  return new CloudError('http-error', `unexpected HTTP ${status} from ${url}`)
}

/** Shape guard for one dirent element. */
function toEntry(raw: unknown, parent: string): CloudEntry | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as Record<string, unknown>
  const name = record.file_name ?? record.name
  if (typeof name !== 'string' || name === '') return undefined
  const type = record.file_type ?? record.type
  const size = record.size
  return {
    name,
    path: joinPath(parent, name),
    type: type === 'dir' ? 'dir' : 'file',
    size: typeof size === 'number' && Number.isFinite(size) ? size : 0,
  }
}

/**
 * List one directory of a shared link.
 * @param target - share key plus the directory path inside it.
 * @param options - timeout and cancellation.
 * @returns entries, sorted directories first then by name.
 */
export async function listDirectory(
  target: ShareTarget,
  options: CloudRequestOptions,
): Promise<CloudEntry[]> {
  const origin = options.origin ?? CLOUD_ORIGIN
  const url = `${origin}/api/v2.1/share-links/${encodeURIComponent(target.shareKey)}/dirents/`
    + `?path=${encodeURIComponent(target.path)}`
  const response = await request(url, options.signal, options.timeoutMs)
  if (!response.ok) throw statusError(response.status, url)

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new CloudError('http-error', 'share API returned a non-JSON body')
  }

  const list = Array.isArray(payload)
    ? payload
    : (typeof payload === 'object' && payload !== null && Array.isArray((payload as Record<string, unknown>).dirent_list)
      ? (payload as Record<string, unknown>).dirent_list as unknown[]
      : [])
  if (!Array.isArray(list)) throw new CloudError('http-error', 'unexpected share API payload shape')

  return list
    .map(item => toEntry(item, target.path))
    .filter((entry): entry is CloudEntry => entry !== undefined)
    .sort((left, right) => {
      if (left.type !== right.type) return left.type === 'dir' ? -1 : 1
      return left.name.localeCompare(right.name, 'zh-Hans-CN')
    })
}

/**
 * Public download URL for one file inside a shared link.
 * @param shareKey - share key.
 * @param filePath - absolute path of the file inside the share.
 * @returns the URL to stream from.
 */
export function fileDownloadUrl(shareKey: string, filePath: string, origin = CLOUD_ORIGIN): string {
  return `${origin}/d/${encodeURIComponent(shareKey)}/files/?p=${encodeURIComponent(filePath)}&dl=1`
}

/**
 * Walk a shared tree and collect every file under it.
 * @param target - starting directory.
 * @param options - timeout, cancellation, and maximum depth.
 * @returns all descendant files with their paths relative to the share root.
 */
export async function walkFiles(
  target: ShareTarget,
  options: CloudRequestOptions & { maxDepth?: number },
): Promise<CloudEntry[]> {
  const maxDepth = options.maxDepth ?? 8
  const collected: CloudEntry[] = []

  const visit = async (current: ShareTarget, depth: number): Promise<void> => {
    if (depth > maxDepth) throw new CloudError('http-error', `directory nesting deeper than ${maxDepth} levels`)
    const entries = await listDirectory(current, options)
    for (const entry of entries) {
      if (entry.type === 'dir') {
        await visit({ shareKey: current.shareKey, path: entry.path }, depth + 1)
      } else {
        collected.push(entry)
      }
    }
  }

  const head = await listDirectory(target, options)
  for (const entry of head) {
    if (entry.type === 'dir') {
      await visit({ shareKey: target.shareKey, path: entry.path }, 1)
    } else {
      collected.push(entry)
    }
  }
  return collected
}
/**
 * Resolve the file list for a share target: walk the directory tree, or fall
 * back to a single file when the path names one (the dirents API answers 404
 * for a file path).
 * @param target - share key plus the path inside the share.
 * @param pattern - `pattern` argument; see {@link nameMatcher}.
 * @param options - timeout, cancellation, and origin override.
 * @returns matching files.
 */
export async function collectShareFiles(
  target: ShareTarget,
  pattern: string | undefined,
  options: CloudRequestOptions,
): Promise<CloudEntry[]> {
  const matcher = nameMatcher(pattern)
  let files: CloudEntry[]
  try {
    files = await walkFiles(target, options)
  } catch (error) {
    if (!(error instanceof CloudError) || error.reason !== 'not-found') throw error
    const name = target.path.split('/').filter(segment => segment !== '').pop() ?? target.path
    files = [{ name, path: target.path, type: 'file', size: 0 }]
  }
  return files.filter(file => matcher(file.name))
}

/** Where a share download writes and what it accomplished. */
export interface ShareDownloadResult {
  readonly directory: string
  readonly downloaded: Array<{ name: string; path: string; bytes: number }>
  readonly failed: Array<{ name: string; reason: string }>
  readonly totalBytes: number
}

/** Inputs for one share download. */
export interface ShareDownloadOptions extends CloudRequestOptions {
  /** Absolute download root for this share. */
  readonly root: string
  /** Filter argument; omit for every file. */
  readonly pattern?: string | undefined
  /** Maximum parallel transfers. */
  readonly concurrency: number
}

/**
 * Download every matching file of a share into `options.root`, preserving the
 * share's directory structure so same-named files cannot collide.
 *
 * One failed file never aborts the rest; the run only fails when nothing could
 * be written.
 * @param target - share key plus the path inside the share.
 * @param options - root, filter, concurrency, timeout, cancellation.
 * @returns what was written and what failed.
 */
export async function downloadShareFiles(
  target: ShareTarget,
  options: ShareDownloadOptions,
): Promise<ShareDownloadResult> {
  const files = await collectShareFiles(target, options.pattern, options)
  if (files.length === 0) {
    throw new CloudError(
      'empty-directory',
      `no files matched${options.pattern === undefined ? '' : ` pattern "${options.pattern}"`} under ${target.path}`,
    )
  }

  const origin = options.origin
  const outcomes = await runPool(files, options.concurrency, async file => {
    const relative = file.path.replace(/^\/+/u, '').split('/').map(safeFileName).join('/')
    const destination = resolveInside(options.root, relative)
    try {
      const url = origin === undefined
        ? fileDownloadUrl(target.shareKey, file.path)
        : fileDownloadUrl(target.shareKey, file.path, origin)
      const bytes = await downloadToFile(url, destination, options)
      return { ok: true as const, name: file.name, path: destination, bytes }
    } catch (error) {
      return { ok: false as const, name: file.name, reason: error instanceof Error ? error.message : String(error) }
    }
  })

  const downloaded = outcomes.filter(outcome => outcome.ok)
  const failed = outcomes.filter(outcome => !outcome.ok)
  if (downloaded.length === 0) {
    throw new Error(`all ${String(failed.length)} download(s) failed: ${failed.slice(0, 3).map(item => `${item.name}: ${item.reason}`).join('; ')}`)
  }
  return {
    directory: options.root,
    downloaded: downloaded.map(item => ({ name: item.name, path: item.path, bytes: item.bytes })),
    failed: failed.map(item => ({ name: item.name, reason: item.reason })),
    totalBytes: downloaded.reduce((sum, item) => sum + item.bytes, 0),
  }
}
