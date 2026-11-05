/**
 * Tsinghua Learn client.
 *
 * Password login goes through `thu-learn-lib` (MIT). That library keeps its
 * cookie jar inside a closure and does not export a way to seed it, so a
 * pasted `THU_LEARN_COOKIE` cannot ride the helper. The cookie path therefore
 * calls the same student JSON endpoints with a `Cookie` header. Both paths
 * return the same records. File bytes go through `downloadToFile`.
 * @module dsh-thu-plugin/learn
 */

import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { ApiError, FailReason, Learn2018Helper } from 'thu-learn-lib'
import type { CourseInfo, File as LearnFile, SemesterInfo } from 'thu-learn-lib'
import type { ThuOptions } from './config.ts'
import { resolveInside, runPool, safeFileName, writeBody } from './download.ts'
import { resolveIdentity } from './identity.ts'

/** Why a Learn call could not proceed. Domain values, not exceptions. */
export type LearnReason =
  | 'missing-credential'
  | 'bad-credential'
  | 'captcha'
  | 'double-auth'
  | 'session-expired'
  | 'login-required'
  | 'network'
  | 'timeout'
  | 'http-error'
  | 'not-found'

/** A failure the tools return instead of throwing. */
export interface LearnFailure {
  readonly ok: false
  readonly reason: LearnReason
  readonly message: string
  readonly credential?: string
}

/** One semester row. */
export interface LearnSemester {
  readonly id: string
  readonly name: string
  readonly current: boolean
}

/** One course row. */
export interface LearnCourse {
  readonly id: string
  readonly name: string
  readonly teacher: string
  readonly time: string
  readonly location: string
}

/** One file row. `downloadUrl` is returned so the user can copy it. */
export interface LearnFileRow {
  readonly id: string
  readonly name: string
  readonly size: number
  readonly uploadedAt: string
  readonly downloadUrl: string
  readonly hasPreview: boolean
}

/** Secrets read at call time. Never returned to the model. */
interface LearnSecrets {
  readonly username?: string
  readonly password?: string
  readonly fingerPrint?: string
  readonly fingerGen?: string
  readonly fingerGen3?: string
  readonly cookie?: string
}

/** What one successful login can do. Tests substitute this. */
export interface LearnSession {
  semesters(): Promise<LearnSemester[]>
  courses(semesterId: string | undefined): Promise<{ semesterId: string; courses: LearnCourse[] }>
  files(courseId: string, category: string | undefined): Promise<LearnFileRow[]>
  download(
    courseId: string,
    fileIds: readonly string[],
    root: string,
    options: { timeoutMs: number; signal: AbortSignal; concurrency: number; overwrite: boolean },
  ): Promise<{
    downloaded: Array<{ name: string; path: string; bytes: number }>
    failed: Array<{ name: string; reason: string }>
  }>
}

const FINGER_GEN = credentialRef('THU_LEARN_FINGER_GEN')
const FINGER_GEN3 = credentialRef('THU_LEARN_FINGER_GEN3')
const COOKIE = credentialRef('THU_LEARN_COOKIE')

const LEARN_ORIGIN = 'https://learn.tsinghua.edu.cn'
const SEMESTER_LIST = `${LEARN_ORIGIN}/b/wlxt/kc/v_wlkc_xs_xktjb_coassb/queryxnxq`
const CURRENT_SEMESTER = `${LEARN_ORIGIN}/b/kc/zhjw_v_code_xnxq/getCurrentAndNextSemester`
const FILE_DOWNLOAD = (fileId: string) =>
  `${LEARN_ORIGIN}/b/wlxt/kj/wlkc_kjxxb/student/downloadFile?sfgk=0&wjid=${encodeURIComponent(fileId)}`

/** Live sessions in this process, keyed by which secret path opened them. */
const live = new Set<string>()

/** Test hook. Production leaves this unset. */
let sessionFactory: ((secrets: LearnSecrets, timeoutMs: number) => Promise<LearnSession>) | undefined

/**
 * Whether a Learn session has succeeded in this process.
 * @returns true after a password or cookie session has listed or downloaded.
 */
export function hasLearnSession(): boolean {
  return live.size > 0
}

/**
 * Replace the session factory. The smoke check uses this so it never talks to SSO.
 * @param factory - factory, or undefined to restore the real one.
 */
export function setLearnSessionFactory(
  factory: ((secrets: LearnSecrets, timeoutMs: number) => Promise<LearnSession>) | undefined,
): void {
  sessionFactory = factory
  live.clear()
}

/**
 * Read Learn secrets at call time. Values stay in this function's result and
 * are never placed in a tool return.
 * @param ctx - context providing the credentials seam.
 * @returns the configured secrets, each possibly absent.
 */
export async function readLearnSecrets(ctx: Context, options: ThuOptions): Promise<LearnSecrets> {
  const [identity, fingerGen, fingerGen3, cookie] = await Promise.all([
    resolveIdentity(ctx, options),
    ctx.credentials.resolve(FINGER_GEN),
    ctx.credentials.resolve(FINGER_GEN3),
    ctx.credentials.resolve(COOKIE),
  ])
  return omitEmpty({
    username: identity.username,
    password: identity.password,
    fingerPrint: identity.fingerprint,
    fingerGen: textOrUndefined(fingerGen?.value),
    fingerGen3: textOrUndefined(fingerGen3?.value),
    cookie: textOrUndefined(cookie?.value),
  })
}

/**
 * Open a session, or return a domain failure when secrets are missing.
 * @param ctx - credentials seam.
 * @param timeoutMs - per-request deadline.
 * @returns a session, or a failure the tool can return as-is.
 */
export async function openLearnSession(
  ctx: Context,
  options: ThuOptions,
  timeoutMs: number,
): Promise<LearnSession | LearnFailure> {
  const secrets = await readLearnSecrets(ctx, options)
  const passwordReady = secrets.username !== undefined && secrets.password !== undefined
  if (!passwordReady && secrets.cookie === undefined) {
    return {
      ok: false,
      reason: 'missing-credential',
      credential: secrets.username === undefined ? options.usernameRef : options.passwordRef,
      message: `Learn needs ${options.usernameRef} and ${options.passwordRef} (the campus account, shared with dsh-thu-automad), or a THU_LEARN_COOKIE. Set them in Settings → Tsinghua tools.`,
    }
  }
  try {
    const open = sessionFactory ?? openRealSession
    const session = await open(secrets, timeoutMs)
    live.add(passwordReady ? 'password' : 'cookie')
    return session
  } catch (error) {
    return toLearnFailure(error)
  }
}

/**
 * True when `openLearnSession` returned a failure rather than a session.
 * @param value - the open result.
 * @returns whether the caller should return it as the tool result.
 */
export function isLearnFailure(value: LearnSession | LearnFailure): value is LearnFailure {
  return 'ok' in value && value.ok === false
}

/** Semester id `2025-2026-1` → `2025-2026 秋季`. */
export function semesterName(id: string): string {
  const match = /^(\d{4})-(\d{4})-(\d)$/u.exec(id)
  if (match === null) return id
  const term = match[3] === '1' ? '秋季' : match[3] === '2' ? '春季' : match[3] === '3' ? '夏季' : match[3]
  return `${match[1]}-${match[2]} ${term ?? ''}`
}

/** Split `timeAndLocation` entries into time and place columns. */
export function splitTimeLocation(entries: readonly string[]): { time: string; location: string } {
  const times: string[] = []
  const places: string[] = []
  for (const entry of entries) {
    const parts = entry.split(/\s+/u).filter(part => part !== '')
    if (parts.length === 0) continue
    times.push(parts[0] ?? '')
    if (parts.length > 1) places.push(parts.slice(1).join(' '))
  }
  return { time: times.join('; '), location: places.join('; ') }
}

function courseRow(course: CourseInfo): LearnCourse {
  const split = splitTimeLocation(course.timeAndLocation)
  return {
    id: course.id,
    name: course.chineseName || course.name,
    teacher: course.teacherName,
    time: split.time,
    location: split.location,
  }
}

function fileRow(file: LearnFile): LearnFileRow {
  return {
    id: file.fileId || file.id,
    // `title` is what the course page shows, and it usually carries no suffix;
    // `fileType` does, so a download lands as something the OS can open.
    name: withExtension(file.title, file.fileType),
    size: file.rawSize,
    uploadedAt: file.uploadTime.toISOString(),
    downloadUrl: file.downloadUrl,
    hasPreview: file.previewUrl !== '',
  }
}

/**
 * Add the file's own type as a suffix when the school's title has none.
 * @param name - the displayed file name.
 * @param fileType - the school's type tag (`pdf`, `mp4`, …) or empty.
 * @returns the name to write to disk.
 */
function withExtension(name: string, fileType: string): string {
  const type = fileType.trim().toLowerCase()
  if (type === '' || /\.[0-9a-z]{1,5}$/iu.test(name)) return name
  return `${name}.${type}`
}

async function openRealSession(secrets: LearnSecrets, timeoutMs: number): Promise<LearnSession> {
  if (secrets.username !== undefined && secrets.password !== undefined && secrets.fingerPrint !== undefined) {
    return helperSession(secrets, timeoutMs)
  }
  if (secrets.cookie !== undefined) return cookieSession(secrets.cookie, timeoutMs)
  throw new LearnError('missing-credential', 'Learn credentials disappeared between the presence check and login')
}

const LEARN_COOKIE_HOST = 'learn.tsinghua.edu.cn'

/** The Learn host cookies seen during the last sign-in, as a `Cookie` header. */
let sessionCookie: string | undefined

/**
 * The jar the library fills lives inside its `#fetch` closure, but that closure
 * calls the *global* `fetch` on every hop and then reads `Set-Cookie` from what
 * comes back. So wrapping `globalThis.fetch` for the duration of a sign-in reads
 * exactly the headers the jar keeps (name=value only, path/HttpOnly dropped by
 * the library as well).
 *
 * The wrapper is observational — every request still reaches the original fetch
 * — it only records cookies for the Learn host, and it is removed in a
 * `finally`. If something else replaced `fetch` while we were inside, the newer
 * one is left alone.
 * @param run - the sign-in to observe.
 * @returns what `run` returned.
 */
async function captureLearnCookies<T>(run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch
  const jar = new Map<string, string>()
  const wrapper = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await original(input, init)
    try {
      const url = input instanceof Request ? input.url : String(input)
      if (new URL(url).hostname === LEARN_COOKIE_HOST) {
        for (const raw of response.headers.getSetCookie()) {
          const pair = raw.split(';')[0] ?? ''
          const separator = pair.indexOf('=')
          if (separator > 0) jar.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim())
        }
      }
    } catch {
      // A header we cannot parse is not worth failing a sign-in over.
    }
    return response
  }) as typeof fetch
  globalThis.fetch = wrapper
  try {
    return await run()
  } finally {
    if (globalThis.fetch === wrapper) globalThis.fetch = original
    if (jar.size > 0) sessionCookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; ')
  }
}

/**
 * A token-aware fetch some builds expose. The 4.x class keeps `#fetchWithToken`
 * private, so this is absent there and its cookie jar is unreachable; when a
 * build does expose it, downloads stay on that jar.
 */
interface TokenFetch {
  fetchWithToken(url: string, init?: { signal?: AbortSignal }): Promise<Response>
}

/** The exposed token fetch, when this build has one. */
function tokenFetchOf(helper: Learn2018Helper): TokenFetch | undefined {
  const candidate = helper as Partial<TokenFetch>
  return typeof candidate.fetchWithToken === 'function' ? candidate as TokenFetch : undefined
}

function helperSession(secrets: LearnSecrets, timeoutMs: number): LearnSession {
  const helper = new Learn2018Helper({
    provider: () => omitEmpty({
      username: secrets.username,
      password: secrets.password,
      fingerPrint: secrets.fingerPrint,
      fingerGenPrint: secrets.fingerGen,
      fingerGenPrint3: secrets.fingerGen3,
    }),
  })
  const tokenFetch = tokenFetchOf(helper)
  // `#fetchWithToken` signs in lazily and does not memoise, so two concurrent
  // calls sign in twice and race on the roaming ticket ("could not fetch
  // ticket"). Sign in once, and let a failure retry on the next call.
  let signIn: Promise<void> | undefined
  const ensureSignIn = async (): Promise<void> => {
    signIn ??= withDeadline(captureLearnCookies(() => helper.login()), timeoutMs).then(
      () => undefined,
      (error: unknown) => {
        signIn = undefined
        throw error
      },
    )
    await signIn
  }
  return {
    async semesters() {
      await ensureSignIn()
      const [ids, current] = await withDeadline(Promise.all([
        helper.getSemesterIdList(),
        helper.getCurrentSemester(),
      ]), timeoutMs)
      return ids.map(id => ({ id, name: semesterName(id), current: id === current.id }))
    },
    async courses(semesterId) {
      await ensureSignIn()
      const current: SemesterInfo = semesterId === undefined
        ? await withDeadline(helper.getCurrentSemester(), timeoutMs)
        : {
            id: semesterId,
            startDate: new Date(0),
            endDate: new Date(0),
            startYear: 0,
            endYear: 0,
            type: 'fall' as SemesterInfo['type'],
          }
      const courses = await withDeadline(helper.getCourseList(current.id), timeoutMs)
      return { semesterId: current.id, courses: courses.map(courseRow) }
    },
    async files(courseId, category) {
      await ensureSignIn()
      const files = await withDeadline(helper.getFileList(courseId), timeoutMs)
      return files
        .filter(file => category === undefined || file.category?.title === category || file.category?.id === category)
        .map(fileRow)
    },
    async download(courseId, fileIds, root, options) {
      await ensureSignIn()
      const files = await withDeadline(helper.getFileList(courseId), timeoutMs)
      return transferFiles(files.map(fileRow), fileIds, root, options, async url => {
        const signal = AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs)])
        const response = tokenFetch !== undefined
          ? await tokenFetch.fetchWithToken(url, { signal })
          : await fetchWithCSRF(url, helper.getCSRFToken(), secrets.cookie ?? sessionCookie, signal)
        guardFileResponse(response)
        return response
      })
    },
  }
}

/**
 * Fetch a Learn file the way the helper would, from outside it: the CSRF token
 * goes in the query string, and a saved cookie rides along when there is one.
 * A password-only session has no cookie to send, which the guard turns into an
 * actionable reason instead of a saved HTML login page.
 */
async function fetchWithCSRF(
  url: string,
  csrf: string,
  cookie: string | undefined,
  signal: AbortSignal,
): Promise<Response> {
  const target = new URL(url)
  if (csrf !== '') target.searchParams.set('_csrf', csrf)
  return fetch(target, {
    ...(cookie === undefined ? {} : { headers: { cookie } }),
    signal,
    redirect: 'follow',
  })
}

/**
 * Reject a file response that is not the file.
 *
 * Learn answers an unauthenticated download with the login page and HTTP 200,
 * so status alone is not enough: an HTML body means the session is missing, and
 * writing it to disk would hand the user a `.pptx` full of markup.
 */
function guardFileResponse(response: Response): void {
  if (response.status === 401 || response.status === 403) {
    throw new LearnError('session-expired', 'The Learn session cannot download files. Save a fresh THU_LEARN_COOKIE.')
  }
  if (!response.ok) throw new LearnError('http-error', `HTTP ${response.status}`)
  const type = response.headers.get('content-type') ?? ''
  if (type.includes('text/html')) {
    throw new LearnError(
      'login-required',
      'Learn answered the download with a login page. Save THU_LEARN_COOKIE (or sign in again), then retry.',
    )
  }
}

/**
 * Cookie path. The helper cannot be seeded, so this talks to the student JSON
 * endpoints directly and sends the cookie on every request, including downloads.
 * @param cookie - raw `Cookie` header value. Never logged.
 * @param timeoutMs - per-request deadline.
 * @returns a session with the same methods as the helper path.
 */
function cookieSession(cookie: string, timeoutMs: number): LearnSession {
  const headers = { cookie, accept: 'application/json' }
  const get = (url: string, signal: AbortSignal) => learnGet(url, headers, timeoutMs, signal)
  return {
    async semesters() {
      const [ids, current] = await Promise.all([
        get(SEMESTER_LIST, AbortSignal.timeout(timeoutMs)),
        get(CURRENT_SEMESTER, AbortSignal.timeout(timeoutMs)),
      ])
      const list = asStringList(ids)
      const currentId = currentIdOf(current)
      return list.map(id => ({ id, name: semesterName(id), current: id === currentId }))
    },
    async courses(semesterId) {
      const currentId = semesterId ?? currentIdOf(await get(CURRENT_SEMESTER, AbortSignal.timeout(timeoutMs)))
      const payload = await get(courseListUrl(currentId), AbortSignal.timeout(timeoutMs))
      return { semesterId: currentId, courses: courseRows(payload) }
    },
    async files(courseId, category) {
      const payload = await get(fileListUrl(courseId), AbortSignal.timeout(timeoutMs))
      return fileRows(payload).filter(row => category === undefined || row.name.includes(category))
    },
    async download(courseId, fileIds, root, options) {
      const listed = await this.files(courseId, undefined)
      return transferFiles(listed, fileIds, root, options, async url => {
        const response = await fetch(url, {
          headers: { cookie, accept: '*/*' },
          signal: AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs)]),
          redirect: 'follow',
        })
        // A stale cookie gets the same HTTP 200 login page a password-only
        // session does; guard it here too, or it lands on disk as the file.
        guardFileResponse(response)
        return response
      })
    },
  }
}

async function transferFiles(
  listed: readonly LearnFileRow[],
  fileIds: readonly string[],
  root: string,
  options: { timeoutMs: number; signal: AbortSignal; concurrency: number; overwrite: boolean },
  fetchFile: (url: string) => Promise<Response>,
): Promise<{
  downloaded: Array<{ name: string; path: string; bytes: number }>
  failed: Array<{ name: string; reason: string }>
}> {
  const byId = new Map(listed.map(file => [file.id, file]))
  const outcomes = await runPool(fileIds, options.concurrency, async fileId => {
    const file = byId.get(fileId)
    if (file === undefined) return { ok: false as const, name: fileId, reason: 'not in this course' }
    const destination = resolveInside(root, safeFileName(file.name))
    try {
      if (!options.overwrite) {
        const { access } = await import('node:fs/promises')
        try {
          await access(destination)
          return { ok: false as const, name: file.name, reason: 'already exists' }
        } catch {
          // missing is the path we want
        }
      }
      const response = await fetchFile(file.downloadUrl)
      const bytes = await writeBody(response, destination, options.signal)
      return { ok: true as const, name: file.name, path: destination, bytes }
    } catch (error) {
      return {
        ok: false as const,
        name: file.name,
        // Keep the domain reason in front of the sentence: the model can act on
        // `login-required` even when it skips the prose.
        reason: error instanceof LearnError
          ? `${error.reason}: ${error.message}`
          : error instanceof Error ? error.message : String(error),
      }
    }
  })
  return {
    downloaded: outcomes.filter(item => item.ok).map(item => ({ name: item.name, path: item.path, bytes: item.bytes })),
    failed: outcomes.filter(item => !item.ok).map(item => ({ name: item.name, reason: item.reason })),
  }
}

class LearnError extends Error {
  constructor(readonly reason: LearnReason, message: string) {
    super(message)
    this.name = 'LearnError'
  }
}

function toLearnFailure(error: unknown): LearnFailure {
  if (error instanceof LearnError) return { ok: false, reason: error.reason, message: error.message }
  if (error instanceof ApiError) {
    const reason = reasonOf(error.reason)
    return { ok: false, reason, message: messageOf(reason) }
  }
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return { ok: false, reason: 'timeout', message: error.message }
  }
  return { ok: false, reason: 'network', message: error instanceof Error ? error.message : String(error) }
}

/**
 * Actionable copy for a failure the school or the library raised. The library's
 * own `reason` is a bare enum name, which tells the model nothing it can act on.
 * @param reason - the mapped domain reason.
 * @returns one sentence naming what to do next.
 */
function messageOf(reason: LearnReason): string {
  switch (reason) {
    case 'missing-credential':
      return 'Learn credentials are incomplete. Save the student id and password in Settings → Tsinghua tools (the two entries dsh-thu-automad shares), or save a THU_LEARN_COOKIE.'
    case 'bad-credential':
      return 'The school rejected the username or password. Save them again in Settings → Tsinghua tools.'
    case 'captcha':
      return 'The school wants a captcha, which a tool call cannot answer. Log in to learn.tsinghua.edu.cn in a browser and save a THU_LEARN_COOKIE instead.'
    case 'double-auth':
      return 'The school asked for two-factor confirmation. Approve it once in a browser, then retry; if it keeps asking, save a THU_LEARN_COOKIE.'
    case 'session-expired':
      return 'The Learn session is gone. Save a fresh THU_LEARN_COOKIE, or retry password login.'
    case 'login-required':
      return 'Listing works, but downloading needs the session cookie: the password login keeps its cookies inside the library. Sign in to learn.tsinghua.edu.cn and save THU_LEARN_COOKIE, then retry.'
    case 'timeout':
      return 'The Learn request timed out. Retry, or raise the plugin timeoutMs.'
    case 'network':
      return 'Could not reach Learn. Check the network and retry.'
    case 'not-found':
      return 'Learn has no such semester or course.'
    case 'http-error':
      return 'Learn returned an unexpected status. Retry shortly.'
  }
}

function reasonOf(reason: FailReason): LearnReason {
  switch (reason) {
    case FailReason.NO_CREDENTIAL: return 'missing-credential'
    case FailReason.BAD_CREDENTIAL: return 'bad-credential'
    case FailReason.CAPTCHA_REQUIRED: return 'captcha'
    case FailReason.DOUBLE_AUTH: return 'double-auth'
    case FailReason.NOT_LOGGED_IN: return 'session-expired'
    case FailReason.ERROR_FETCH_FROM_ID:
    case FailReason.ERROR_ROAMING: return 'network'
    default: return 'http-error'
  }
}

async function withDeadline<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new LearnError('timeout', `Learn request timed out after ${timeoutMs}ms`)), timeoutMs)
  })
  try {
    return await Promise.race([work, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

async function learnGet(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<unknown> {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
  let response: Response
  try {
    response = await fetch(url, { headers, signal: deadline, redirect: 'follow' })
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new LearnError('timeout', `Learn request timed out after ${timeoutMs}ms`)
    }
    throw new LearnError('network', error instanceof Error ? error.message : String(error))
  }
  if (response.status === 401 || response.status === 403 || response.url.includes('login_timeout')) {
    throw new LearnError('session-expired', 'Learn cookie is missing or expired')
  }
  if (!response.ok) throw new LearnError('http-error', `HTTP ${response.status}`)
  try {
    return await response.json()
  } catch {
    throw new LearnError('session-expired', 'Learn returned a non-JSON page, usually a login redirect')
  }
}

function asStringList(payload: unknown): string[] {
  if (!Array.isArray(payload)) throw new LearnError('http-error', 'semester list was not an array')
  return payload.filter((item): item is string => typeof item === 'string')
}

function currentIdOf(payload: unknown): string {
  if (typeof payload !== 'object' || payload === null) throw new LearnError('http-error', 'current semester payload was not an object')
  const result = (payload as { result?: { id?: unknown } }).result
  if (typeof result?.id !== 'string') throw new LearnError('http-error', 'current semester id missing')
  return result.id
}

function courseListUrl(semesterId: string): string {
  return `${LEARN_ORIGIN}/b/wlxt/kc/v_wlkc_xs_xkb_kcb_extend/student/loadCourseBySemesterId/${encodeURIComponent(semesterId)}/zh`
}

function fileListUrl(courseId: string): string {
  return `${LEARN_ORIGIN}/b/wlxt/kj/wlkc_kjxxb/student/kjxxbByWlkcidAndSizeForStudent?wlkcid=${encodeURIComponent(courseId)}&size=200`
}

function courseRows(payload: unknown): LearnCourse[] {
  if (typeof payload !== 'object' || payload === null) throw new LearnError('http-error', 'course list was not an object')
  const list = (payload as { resultList?: unknown }).resultList
  if (!Array.isArray(list)) throw new LearnError('http-error', 'course list missing resultList')
  return list.flatMap(item => {
    if (typeof item !== 'object' || item === null) return []
    const row = item as { wlkcid?: unknown; kcm?: unknown; jsm?: unknown; timeAndLocation?: unknown }
    if (typeof row.wlkcid !== 'string') return []
    const split = splitTimeLocation(stringList(row.timeAndLocation))
    return [{
      id: row.wlkcid,
      name: typeof row.kcm === 'string' ? row.kcm : row.wlkcid,
      teacher: typeof row.jsm === 'string' ? row.jsm : '',
      time: split.time,
      location: split.location,
    }]
  })
}

function fileRows(payload: unknown): LearnFileRow[] {
  if (typeof payload !== 'object' || payload === null) throw new LearnError('http-error', 'file list was not an object')
  const object = (payload as { object?: unknown }).object
  if (!Array.isArray(object)) throw new LearnError('http-error', 'file list missing object array')
  return object.flatMap(item => {
    if (typeof item !== 'object' || item === null) return []
    const row = item as { wjid?: unknown; bt?: unknown; wjdx?: unknown; scsj?: unknown }
    if (typeof row.wjid !== 'string') return []
    const uploaded = typeof row.scsj === 'string' || typeof row.scsj === 'number' ? new Date(row.scsj) : new Date(0)
    return [{
      id: row.wjid,
      name: typeof row.bt === 'string' ? row.bt : row.wjid,
      size: typeof row.wjdx === 'number' ? row.wjdx : 0,
      uploadedAt: Number.isNaN(uploaded.getTime()) ? '' : uploaded.toISOString(),
      downloadUrl: FILE_DOWNLOAD(row.wjid),
      hasPreview: false,
    }]
  })
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

function omitEmpty<T extends Record<string, string | undefined>>(value: T): { [K in keyof T]?: string } {
  const kept: { [K in keyof T]?: string } = {}
  for (const key of Object.keys(value) as Array<keyof T>) {
    const item = value[key]
    if (item !== undefined) kept[key] = item
  }
  return kept
}

function textOrUndefined(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === '') return undefined
  return value
}
