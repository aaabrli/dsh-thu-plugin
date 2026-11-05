/**
 * Filesystem side of every download: safe names, atomic writes, bounded
 * concurrency. Deliberately knows nothing about Seafile, Learn, or reserves —
 * all three capabilities funnel through here so the panel button and the tool
 * share one code path.
 */

import { createWriteStream } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

/**
 * Strip anything that would let a remote name escape the download directory or
 * confuse a shell. Names are data from the network, so this is not optional.
 * @param name - remote file name.
 * @returns a single safe path segment.
 */
export function safeFileName(name: string): string {
  const cleaned = name
    .replaceAll('/', '_')
    .replaceAll('\\', '_')
    .replace(/[\u0000-\u001f\u007f]/gu, '')
    .replace(/^\.+/u, '')
    .trim()
  return cleaned === '' ? 'unnamed' : cleaned
}

/**
 * Resolve a path inside the download root, refusing anything that escapes it.
 * @param root - absolute download root.
 * @param relative - slash-separated path relative to the root.
 * @returns the absolute target path.
 */
export function resolveInside(root: string, relative: string): string {
  const target = resolve(root, ...relative.split('/').filter(segment => segment !== ''))
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`
  if (target !== root && !target.startsWith(prefix)) {
    throw new Error(`refusing to write outside ${root}: ${relative}`)
  }
  return target
}

/**
 * Stream one URL to disk atomically: write `<dest>.part`, then rename. A
 * failed or cancelled transfer never leaves a truncated file under the real
 * name.
 * @param url - source URL.
 * @param destination - absolute target path.
 * @param options - per-request timeout, caller cancellation, and optional headers.
 * @returns number of bytes written.
 */
export async function downloadToFile(
  url: string,
  destination: string,
  options: { timeoutMs: number; signal: AbortSignal; headers?: Record<string, string> },
): Promise<number> {
  const deadline = AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs)])
  const response = await fetch(url, {
    signal: deadline,
    redirect: 'follow',
    ...(options.headers === undefined ? {} : { headers: options.headers }),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`)
  return writeBody(response, destination, options.signal)
}

/**
 * Stream an already-open response to disk atomically. Learn's password path
 * spends the request on the library's cookie jar and then hands the body here,
 * so cookie downloads and password downloads share one write.
 * @param response - a successful body. A non-OK status throws.
 * @param destination - absolute target path. A sibling `.part` is renamed into place.
 * @param signal - caller cancellation; an abort removes the partial file.
 * @returns number of bytes written.
 */
export async function writeBody(response: Response, destination: string, signal: AbortSignal): Promise<number> {
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  if (response.body === null) throw new Error('empty response body')

  await mkdir(dirname(destination), { recursive: true })
  const partial = `${destination}.part`
  let bytes = 0
  try {
    await pipeline(
      Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
      async function* count(source: AsyncIterable<Uint8Array>) {
        for await (const chunk of source) {
          if (signal.aborted) throw signal.reason ?? new Error('aborted')
          bytes += chunk.byteLength
          yield chunk
        }
      },
      createWriteStream(partial),
    )
    await rename(partial, destination)
  } catch (error) {
    await rm(partial, { force: true })
    throw error
  }
  return bytes
}

/**
 * Run `worker` over `items` with at most `concurrency` in flight, preserving
 * input order in the result array.
 * @param items - work items.
 * @param concurrency - maximum parallel workers.
 * @param worker - async body returning one result per item.
 * @returns results in input order.
 */
export async function runPool<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  const runners = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      results[index] = await worker(items[index] as T, index)
    }
  })
  await Promise.all(runners)
  return results
}

/**
 * Directory shown to the user for a download root that may be relative.
 * @param workingDirectory - the session's absolute cwd.
 * @param configured - the configured root, relative or absolute.
 * @returns the absolute download root.
 */
export function downloadRoot(workingDirectory: string, configured: string): string {
  return resolve(workingDirectory, configured)
}

/**
 * Human-readable byte size.
 * @param bytes - raw count.
 * @returns e.g. `1.4 MB`.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`
}

/** Join a root and slash-separated child segments. */
export function joinUnder(root: string, ...segments: string[]): string {
  return join(root, ...segments.filter(segment => segment !== ''))
}