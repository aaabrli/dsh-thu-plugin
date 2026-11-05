/**
 * Paper search against Semantic Scholar.
 *
 * This is the one paper capability that does not go through `instsci`. The
 * upstream `search` command prints a Rich table and has no machine-readable
 * format, so parsing it would be more fragile than calling the public endpoint
 * it wraps; and searching needs no institutional access, so there is no reason
 * to start a Python process for it. No API key is used: the unauthenticated
 * endpoint rate-limits per address, and a 429 is reported as data.
 * @module dsh-thu-plugin/papers/search
 */

/** One search hit, flattened to the fields a caller acts on. */
export interface PaperHit {
  title: string
  authors: string[]
  year?: number
  /** Journal or venue as the record names it. */
  venue?: string
  doi?: string
  arxivId?: string
  citations: number
  abstract?: string
  url: string
}

/** Why a search did not return hits. Both are values, not exceptions. */
export type PaperSearchFailure =
  | { readonly ok: false; readonly reason: 'rate-limited'; readonly message: string; readonly retryAfterSec?: number }
  | { readonly ok: false; readonly reason: 'bad-request'; readonly message: string }

/** A finished search. */
export interface PaperSearchSuccess {
  readonly ok: true
  /** Hits matched in total, before the limit. */
  readonly total: number
  readonly results: PaperHit[]
}

/** Result of one search. Network failures and 5xx still throw. */
export type PaperSearchResult = PaperSearchSuccess | PaperSearchFailure

/** Arguments one search accepts. */
export interface PaperSearchArgs {
  readonly query: string
  /** 1–100. */
  readonly limit: number
  /** Inclusive year range, e.g. `2020-2024` or a single year. */
  readonly year?: string
}

/** Per-call knobs. `origin` exists so the check can point at a loopback server. */
export interface PaperSearchOptions {
  readonly timeoutMs: number
  readonly signal: AbortSignal
  /** Base URL override, test seam only. */
  readonly origin?: string
}

const FIELDS = 'title,authors,year,venue,externalIds,citationCount,abstract,url'

/** Longest abstract kept; a model reading ten hits does not need more. */
const MAX_ABSTRACT = 800

/** Clamp a requested page size into what the endpoint accepts. */
function pageSize(limit: number): number {
  return Math.min(Math.max(Math.trunc(limit), 1), 100)
}

/**
 * Search papers by keyword.
 * @param args - query, limit, optional year range.
 * @param options - timeout, cancellation, and the test origin override.
 * @returns hits, or a failure the tool returns as-is.
 */
export async function searchPapers(args: PaperSearchArgs, options: PaperSearchOptions): Promise<PaperSearchResult> {
  const origin = options.origin ?? 'https://api.semanticscholar.org'
  const url = new URL('/graph/v1/paper/search', origin)
  url.searchParams.set('query', args.query)
  url.searchParams.set('limit', String(pageSize(args.limit)))
  url.searchParams.set('fields', FIELDS)
  if (args.year !== undefined && args.year.length > 0) url.searchParams.set('year', args.year)

  const deadline = AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs)])
  const response = await fetch(url, { signal: deadline, redirect: 'follow' })

  if (response.status === 429) {
    const retry = Number.parseInt(response.headers.get('retry-after') ?? '', 10)
    return {
      ok: false,
      reason: 'rate-limited',
      message: 'Semantic Scholar rate-limited this machine. Wait a few seconds and search again, or use a narrower query.',
      ...(Number.isFinite(retry) && retry > 0 ? { retryAfterSec: retry } : {}),
    }
  }
  if (response.status >= 400 && response.status < 500) {
    return { ok: false, reason: 'bad-request', message: `Semantic Scholar rejected the query (HTTP ${String(response.status)}).` }
  }
  if (!response.ok) throw new Error(`Semantic Scholar answered HTTP ${String(response.status)}`)

  const body = await response.json() as { total?: unknown; data?: unknown }
  const rows = Array.isArray(body.data) ? body.data : []
  const total = typeof body.total === 'number' ? body.total : rows.length
  return { ok: true, total, results: rows.map(hitOf).filter((hit): hit is PaperHit => hit !== undefined) }
}

/** Flatten one API row. A row without a title is dropped, not guessed at. */
function hitOf(row: unknown): PaperHit | undefined {
  if (typeof row !== 'object' || row === null) return undefined
  const record = row as Record<string, unknown>
  const title = typeof record.title === 'string' ? record.title.trim() : ''
  if (title.length === 0) return undefined
  const external = typeof record.externalIds === 'object' && record.externalIds !== null
    ? record.externalIds as Record<string, unknown>
    : {}
  const doi = typeof external.DOI === 'string' ? external.DOI : undefined
  const arxivId = typeof external.ArXiv === 'string' ? external.ArXiv : undefined
  return {
    title,
    authors: Array.isArray(record.authors)
      ? record.authors
        .map(author => (typeof author === 'object' && author !== null && typeof (author as { name?: unknown }).name === 'string'
          ? (author as { name: string }).name
          : undefined))
        .filter((name): name is string => name !== undefined)
      : [],
    ...(typeof record.year === 'number' ? { year: record.year } : {}),
    ...(typeof record.venue === 'string' && record.venue.trim().length > 0 ? { venue: record.venue.trim() } : {}),
    ...(doi === undefined ? {} : { doi }),
    ...(arxivId === undefined ? {} : { arxivId }),
    citations: typeof record.citationCount === 'number' ? record.citationCount : 0,
    ...(typeof record.abstract === 'string' && record.abstract.trim().length > 0
      ? { abstract: record.abstract.trim().slice(0, MAX_ABSTRACT) }
      : {}),
    url: typeof record.url === 'string' ? record.url : doi === undefined ? '' : `https://doi.org/${doi}`,
  }
}