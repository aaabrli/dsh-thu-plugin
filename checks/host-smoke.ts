/**
 * Local behavioral check for the Host half.
 *
 *   pnpm run check:host        (from this package)
 *
 * It loads `src/index.ts` and drives the real `apply` against a stub Context, so
 * tool registration, config validation, and the cloud client are exercised
 * without a DSH host. The cloud client runs against a loopback HTTP server, which
 * is why `CloudRequestOptions` carries an `origin` override.
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import {
  CloudError,
  downloadShareFiles,
  fileDownloadUrl,
  listDirectory,
  normalizePath,
  parseShareTarget,
  walkFiles,
} from '../src/cloud.ts'
import { formatBytes, resolveInside, runPool, safeFileName } from '../src/download.ts'
import { nameMatcher } from '../src/pattern.ts'
import { apply } from '../src/index.ts'
import { semesterName, setLearnSessionFactory, splitTimeLocation } from '../src/learn.ts'
import { bookIdOf, tokenExpiry } from '../src/reserves.ts'
import { readInstall, readPanel, writeCredential } from '../src/panel.ts'
import { AUTOMAD_SPEC, automadBundled, automadSpec } from '../src/automad.ts'
import {
  FINGERPRINT_PATTERN, SHARED_SESSION_KEY, resolveIdentity, sharedFingerprint,
} from '../src/identity.ts'
import { defaultReservesCli, reservesCliPath } from '../src/config.ts'
import {
  arxivOf,
  extractJson,
  fetchPaper,
  findOnPath,
  paperDirectory,
  paperFileName,
  pdfProblem,
  spawnWithDeadline,
} from '../src/papers/fetch.ts'
import { searchPapers } from '../src/papers/search.ts'

/** Tool signature the stub registry records. */
type StubExecute = (
  args: Record<string, unknown>,
  exec: { signal: AbortSignal; agent: object },
) => Promise<Record<string, unknown>>

/** One registered tool captured by the stub registry. */
interface StubTool {
  name: string
  execute: StubExecute
}

/** Build the tool, credential, and working-directory surface the plugin uses. */
function harness(
  presence: Record<string, boolean>,
  cwd: string,
  secrets: Record<string, string> = {},
  records: Map<string, unknown> = new Map(),
): { ctx: Context; tools: StubTool[]; dispose: () => void } {
  const tools: StubTool[] = []
  const disposers: Array<() => void> = []
  const ctx = {
    credentials: {
      describe: (ref: string) => Promise.resolve({ configured: presence[ref] === true, writable: true }),
      resolve: (ref: string) => Promise.resolve(secrets[ref] === undefined ? undefined : { value: secrets[ref] }),
      readRecord: (key: string) => Promise.resolve(records.get(key)),
      modifyRecord: (key: string, mutate: (current: unknown) => Promise<unknown>) =>
        mutate(records.get(key)).then(next => {
          if (next === undefined) records.delete(key)
          else records.set(key, next)
          return next
        }),
    },
    workingDirectory: {
      ensure: () => Promise.resolve(cwd),
    },
    connection: {
      fetch: {
        register: () => () => Promise.resolve(),
      },
    },
    tools: {
      register: (tool: StubTool) => {
        tools.push(tool)
        return () => {
          const index = tools.indexOf(tool)
          if (index >= 0) tools.splice(index, 1)
        }
      },
    },
    effect: (run: () => unknown) => {
      const disposer = run()
      if (typeof disposer === 'function') disposers.push(disposer as () => void)
      return disposer
    },
  }
  return {
    ctx: ctx as unknown as Context,
    tools,
    dispose: () => {
      for (const disposer of disposers.splice(0)) disposer()
    },
  }
}

const work = await mkdtemp(join(tmpdir(), 'thu-plugin-check-'))

// ---------------------------------------------------------------------------
// Registration and tool contracts
// ---------------------------------------------------------------------------

const full = harness({ MADMODEL_USERNAME: true, MADMODEL_PASSWORD: true }, work)
apply(full.ctx, undefined)
assert.deepEqual(full.tools.map(tool => tool.name).sort(), [
  'thu_cloud_download',
  'thu_cloud_list',
  'thu_learn_courses',
  'thu_learn_download',
  'thu_learn_files',
  'thu_learn_semesters',
  'thu_paper_fetch',
  'thu_paper_search',
  'thu_reserves_download',
  'thu_status',
])

const signal = new AbortController().signal
const agent = {}
const exec = { signal, agent }

const status = await full.tools.find(tool => tool.name === 'thu_status')?.execute({}, exec)
assert.deepEqual(status?.learn, { credential: true, session: false, sharedFingerprint: false })
assert.deepEqual(status?.reserves, { cli: false, token: false })
// The paper row reports this machine's own state, so only the credential fact is fixed.
const papersStatus = status?.papers as { cli?: string; email: boolean; school?: string }
assert.equal(papersStatus.email, false)
assert.equal(papersStatus.cli === undefined || typeof papersStatus.cli === 'string', true)

const listTool = full.tools.find(tool => tool.name === 'thu_cloud_list')
const badList = await listTool?.execute({ url: 'https://example.com/d/abc12345/' }, exec)
assert.equal(badList?.ok, false)
assert.equal(badList?.reason, 'invalid-url')

const downloadTool = full.tools.find(tool => tool.name === 'thu_cloud_download')
const badDownload = await downloadTool?.execute({ url: 'not a link' }, exec)
assert.equal(badDownload?.ok, false)
assert.equal(badDownload?.reason, 'invalid-url')
assert.deepEqual(badDownload?.downloaded, [])

full.dispose()
assert.equal(full.tools.length, 0)

const empty = harness({}, work)
apply(empty.ctx, { downloadDir: 'thu-downloads', concurrency: 2 })
const missing = await empty.tools.find(tool => tool.name === 'thu_status')?.execute({}, exec)
assert.equal((missing?.learn as { credential: boolean }).credential, false)

assert.throws(() => { apply(harness({}, work).ctx, { nope: true }) }, /unknown config key/u)
assert.throws(() => { apply(harness({}, work).ctx, { reservesDelayMs: 100 }) }, /reservesDelayMs/u)
assert.throws(() => { apply(harness({}, work).ctx, { downloadDir: '../escape' }) }, /downloadDir/u)

// ---------------------------------------------------------------------------
// Learn: missing credential is a domain result; a stub session never talks to SSO
// ---------------------------------------------------------------------------

assert.equal(semesterName('2025-2026-1'), '2025-2026 秋季')
assert.equal(semesterName('2025-2026-2'), '2025-2026 春季')
assert.deepEqual(splitTimeLocation(['周一第1节 六教']), { time: '周一第1节', location: '六教' })

const learnMissing = harness({}, work)
apply(learnMissing.ctx, undefined)
const noSecret = await learnMissing.tools.find(tool => tool.name === 'thu_learn_semesters')?.execute({}, exec)
assert.equal(noSecret?.ok, false)
assert.equal(noSecret?.reason, 'missing-credential')
assert.deepEqual(noSecret?.semesters, [])
learnMissing.dispose()

setLearnSessionFactory(async () => ({
  semesters: () => Promise.resolve([{ id: '2025-2026-1', name: '2025-2026 秋季', current: true }]),
  courses: () => Promise.resolve({
    semesterId: '2025-2026-1',
    courses: [{ id: 'c1', name: '线性代数', teacher: '张', time: '周一第1节', location: '六教' }],
  }),
  files: () => Promise.resolve([{
    id: 'f1',
    name: 'notes.pdf',
    size: 4,
    uploadedAt: '2025-09-01T00:00:00.000Z',
    downloadUrl: 'http://127.0.0.1/f1',
    hasPreview: false,
  }]),
  download: () => Promise.resolve({
    downloaded: [{ name: 'notes.pdf', path: join(work, 'notes.pdf'), bytes: 4 }],
    failed: [],
  }),
}))

const learnReady = harness(
  { MADMODEL_USERNAME: true, MADMODEL_PASSWORD: true, THU_LEARN_FINGERPRINT: true },
  work,
  { MADMODEL_USERNAME: 'u', MADMODEL_PASSWORD: 'p', THU_LEARN_FINGERPRINT: 'fp' },
)
apply(learnReady.ctx, undefined)
const semesters = await learnReady.tools.find(tool => tool.name === 'thu_learn_semesters')?.execute({}, exec)
assert.equal(semesters?.ok, true)
assert.equal((semesters?.semesters as Array<{ current: boolean }>)[0]?.current, true)
const afterLogin = await learnReady.tools.find(tool => tool.name === 'thu_status')?.execute({}, exec)
assert.equal((afterLogin?.learn as { session: boolean }).session, true)
const downloaded = await learnReady.tools.find(tool => tool.name === 'thu_learn_download')?.execute({
  courseId: 'c1',
  fileIds: ['f1'],
}, exec)
assert.equal(downloaded?.ok, true)
assert.equal((downloaded?.downloaded as Array<{ name: string }>)[0]?.name, 'notes.pdf')
learnReady.dispose()
setLearnSessionFactory(undefined)

const stored = new Map<string, string>()
const sharedRecords = new Map<string, unknown>()
const credCtx = {
  credentials: {
    describe: (ref: string) => Promise.resolve({ configured: stored.has(ref), writable: ref !== 'THU_LEARN_COOKIE' || stored.size >= 0 }),
    set: (ref: string, value: string) => {
      stored.set(ref, value)
      return Promise.resolve()
    },
    unset: (ref: string) => {
      stored.delete(ref)
      return Promise.resolve()
    },
    readRecord: (key: string) => Promise.resolve(sharedRecords.get(key)),
    modifyRecord: (key: string, mutate: (current: unknown) => Promise<unknown>) =>
      mutate(sharedRecords.get(key)).then(next => {
        if (next === undefined) sharedRecords.delete(key)
        else sharedRecords.set(key, next)
        return next
      }),
  },
} as unknown as import('@deepseek-ai/cordis').Context
const bare = {
  downloadDir: 'thu-downloads',
  concurrency: 2,
  timeoutMs: 90_000,
  reservesDelayMs: 1_500,
  reservesCli: '',
  reservesTokenFile: '',
  reservesTimeoutMs: 1_800_000,
  usernameRef: 'MADMODEL_USERNAME',
  passwordRef: 'MADMODEL_PASSWORD',
  paperCli: '',
  paperDir: '',
  paperSchool: '清华大学',
  paperSchoolEn: 'Tsinghua University',
  paperEmailRef: 'THU_PAPER_EMAIL',
  paperTimeoutMs: 1_200_000,
}
const saved = await writeCredential(credCtx, bare, 'password', 'secret-value')
assert.equal(saved.ok, true)
assert.equal(stored.get('MADMODEL_PASSWORD'), 'secret-value')
const cleared = await writeCredential(credCtx, { ...bare }, 'password', '  ')
assert.equal(cleared.ok, true)
assert.equal(stored.has('MADMODEL_PASSWORD'), false)
const unknown = await writeCredential(credCtx, { ...bare }, 'nope', 'x')
assert.equal(unknown.ok, false)
assert.equal(JSON.stringify(saved).includes('secret-value'), false)
assert.equal(reservesCliPath(bare), defaultReservesCli(), 'an unset reservesCli falls back to the install target')
assert.ok(defaultReservesCli().includes('dsh-thu-plugin'), 'the default lives under the plugin home')
assert.equal(reservesCliPath({ ...bare, reservesCli: '/opt/x/downloader' }), '/opt/x/downloader')
assert.equal(readInstall('missing'), undefined)

const snapshot = await readPanel(credCtx, bare)
assert.deepEqual(snapshot.fields.map(field => field.id), ['username', 'password', 'fingerprint', 'cookie', 'reserves-token', 'paper-email'])
assert.equal(snapshot.fields.every(field => field.writable && !field.configured), true)
assert.equal(snapshot.tools[0]?.path, defaultReservesCli())
assert.deepEqual(snapshot.tools.map(tool => tool.id), ['reserves', 'papers', 'automad'])
const automadRow = snapshot.tools.find(tool => tool.id === 'automad')
assert.ok(automadRow !== undefined && automadRow.id === 'automad', 'the panel reports the automad row')
assert.equal(automadRow.spec, AUTOMAD_SPEC)
assert.equal(typeof automadRow.installed, 'string')
assert.equal(typeof automadRow.bundled, 'boolean')

// A profile manifest is read, not guessed: dependency and bundle list are separate facts.
const probeProfile = { name: 'probe', dir: join(work, 'profile-probe') }
await mkdir(probeProfile.dir, { recursive: true })
await writeFile(join(probeProfile.dir, 'package.json'), JSON.stringify({
  dependencies: { 'dsh-thu-automad': 'github:aaabrli/dsh-thu-automad' },
  dsh: { profile: { bundles: ['dsh-thu-automad'] } },
}))
assert.equal(await automadSpec(probeProfile), 'github:aaabrli/dsh-thu-automad')
assert.equal(await automadBundled(probeProfile), true)
await writeFile(join(probeProfile.dir, 'package.json'), JSON.stringify({
  dependencies: { 'dsh-thu-automad': 'github:aaabrli/dsh-thu-automad' },
  dsh: { profile: { bundles: [] } },
}))
assert.equal(await automadBundled(probeProfile), false, 'a listed dependency without a bundle entry is not loaded')
assert.equal(await automadSpec({ name: 'absent', dir: join(work, 'profile-absent') }), undefined)
assert.equal(await automadBundled({ name: 'absent', dir: join(work, 'profile-absent') }), false)

const tokenWrite = await writeCredential(credCtx, { ...bare }, 'reserves-token', 'jwt-value')
assert.equal(tokenWrite.ok, true)
assert.equal(stored.get('THU_RESERVES_TOKEN'), 'jwt-value')

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

assert.deepEqual(parseShareTarget('https://cloud.tsinghua.edu.cn/d/abc12345/'), { shareKey: 'abc12345', path: '/' })
assert.deepEqual(parseShareTarget('https://cloud.tsinghua.edu.cn/d/abc12345/?p=/notes'), { shareKey: 'abc12345', path: '/notes' })
assert.deepEqual(parseShareTarget('abc12345', '/x/y/'), { shareKey: 'abc12345', path: '/x/y' })
assert.throws(() => { parseShareTarget('https://cloud.example.com/d/abc12345/') }, /cloud\.tsinghua\.edu\.cn/u)
assert.throws(() => { parseShareTarget('https://cloud.tsinghua.edu.cn/f/abc12345/') }, /share links/u)
assert.equal(normalizePath('//a///b//'), '/a/b')
assert.equal(normalizePath('/'), '/')

assert.equal(safeFileName('../../etc/passwd').startsWith('.'), false)
assert.equal(safeFileName('../../etc/passwd').includes('/'), false)
assert.equal(safeFileName('   '), 'unnamed')
assert.throws(() => { resolveInside('/tmp/root', '../outside.txt') }, /outside/u)

assert.equal(nameMatcher(undefined)('anything.bin'), true)
assert.equal(nameMatcher('.pdf')('a.PDF'), true)
assert.equal(nameMatcher('.pdf')('a.docx'), false)
assert.equal(nameMatcher('*.pptx, .pdf')('x.pptx'), true)
assert.equal(nameMatcher('lecture-?')('lecture-3'), true)
assert.equal(nameMatcher('lecture-?')('lecture-10'), false)

assert.equal(formatBytes(999), '999 B')
assert.equal(formatBytes(1536), '1.5 KB')

assert.deepEqual(await runPool([1, 2, 3, 4], 2, async value => value * 2), [2, 4, 6, 8])

// ---------------------------------------------------------------------------
// Reserves subprocess wrapper
// ---------------------------------------------------------------------------

const BOOK_ID = '092404F541465700E065000000000001'
const BOOK_URL_OK = `https://ereserves.lib.tsinghua.edu.cn/bookDetail/${BOOK_ID}`

assert.equal(bookIdOf(BOOK_URL_OK), BOOK_ID)
assert.equal(bookIdOf(`${BOOK_URL_OK}/`), BOOK_ID, 'a trailing slash is accepted')
assert.equal(bookIdOf('https://example.com/bookDetail/abc'), undefined, 'only the reserves origin is accepted')
assert.equal(bookIdOf('https://ereserves.lib.tsinghua.edu.cn/other/abc'), undefined)
assert.equal(tokenExpiry('not-a-jwt'), undefined)

const jwt = (payload: object): string => `x.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.y`
const futureExp = Math.floor(Date.now() / 1_000) + 3_600
assert.equal(tokenExpiry(jwt({ exp: futureExp })), futureExp)

const reservesWork = join(work, 'reserves-run')
await mkdir(reservesWork, { recursive: true })
const fakeCli = join(reservesWork, 'fake-downloader')
await writeFile(fakeCli, [
  '#!/bin/sh',
  'url=""',
  'while [ $# -gt 0 ]; do',
  '  case "$1" in',
  '    -u) url="$2"; shift 2 ;;',
  '    *) shift ;;',
  '  esac',
  'done',
  'id="${url##*/}"',
  'if [ ! -f token.txt ]; then',
  '  echo "Token need to renew."',
  '  exit 1',
  'fi',
  'echo "Bookname: Fake Book"',
  'echo "Clawed 3 pages in total, time usage: 0.1s"',
  'printf "%%PDF-1.4 fake" > "$id.pdf"',
  'echo "PDF path: $id.pdf"',
  'echo "Done."',
].join('\n'), { mode: 0o755 })

/** Drive the reserves tool through the real `apply` with one config. */
async function reservesCall(
  config: unknown,
  secrets: Record<string, string>,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const local = harness({}, reservesWork, secrets)
  apply(local.ctx, config)
  const tool = local.tools.find(item => item.name === 'thu_reserves_download')
  assert.ok(tool !== undefined, 'the reserves tool registers')
  try {
    return await tool.execute(args, exec)
  } finally {
    local.dispose()
  }
}

const noCli = await reservesCall(undefined, {}, { url: BOOK_URL_OK })
assert.equal(noCli.reason, 'cli-missing', 'a missing CLI is a domain failure, not a throw')

const noToken = await reservesCall({ reservesCli: fakeCli }, {}, { url: BOOK_URL_OK })
assert.equal(noToken.reason, 'token-missing')

const badToken = await reservesCall({ reservesCli: fakeCli }, { THU_RESERVES_TOKEN: 'not-a-jwt' }, { url: BOOK_URL_OK })
assert.equal(badToken.reason, 'token-invalid')

const stale = await reservesCall({ reservesCli: fakeCli }, { THU_RESERVES_TOKEN: jwt({ exp: 1_000_000_000 }) }, { url: BOOK_URL_OK })
assert.equal(stale.reason, 'token-expired', 'an expired token never spawns the CLI')

const wrongUrl = await reservesCall({ reservesCli: fakeCli }, { THU_RESERVES_TOKEN: jwt({ exp: futureExp }) }, { url: 'https://example.com/x' })
assert.equal(wrongUrl.reason, 'invalid-url')

const done = await reservesCall({ reservesCli: fakeCli }, { THU_RESERVES_TOKEN: jwt({ exp: futureExp }) }, { url: BOOK_URL_OK })
assert.equal(done.ok, true, `a successful run reports ok: ${JSON.stringify(done)}`)
assert.equal(done.bookId, BOOK_ID)
assert.equal(done.book, 'Fake Book')
assert.equal(done.pages, 3)
assert.equal(done.path, join(reservesWork, 'thu-downloads', 'reserves', `${BOOK_ID}.pdf`))
assert.equal(await readFile(done.path as string, 'utf8'), '%PDF-1.4 fake', 'the PDF is moved out of the temp directory')

const again = await reservesCall({ reservesCli: fakeCli }, { THU_RESERVES_TOKEN: jwt({ exp: futureExp }) }, { url: BOOK_URL_OK })
assert.equal(again.path, join(reservesWork, 'thu-downloads', 'reserves', `${BOOK_ID}-1.pdf`), 'a second run does not clobber the first')

const tokenFile = join(reservesWork, 'token-from-file.txt')
await writeFile(tokenFile, `${jwt({ exp: futureExp })}\n`, { mode: 0o600 })
const fromFile = await reservesCall({ reservesCli: fakeCli, reservesTokenFile: tokenFile }, {}, { url: BOOK_URL_OK })
assert.equal(fromFile.ok, true, 'reservesTokenFile is a fallback for the credential')

// ---------------------------------------------------------------------------
// Paper fetching through a fake instsci CLI
// ---------------------------------------------------------------------------

const papersWork = join(work, 'papers-run')
await mkdir(papersWork, { recursive: true })
const fakeInstsci = join(papersWork, 'instsci')
await writeFile(fakeInstsci, [
  '#!/bin/sh',
  'id=""',
  'out=""',
  'while [ $# -gt 0 ]; do',
  '  case "$1" in',
  '    fetch) id="$2"; shift 2 ;;',
  '    --output) out="$2"; shift 2 ;;',
  '    *) shift ;;',
  '  esac',
  'done',
  'if [ "$COLUMNS" != "100000" ] || [ "$NO_COLOR" != "1" ]; then',
  '  echo "unexpected terminal env: COLUMNS=$COLUMNS NO_COLOR=$NO_COLOR" >&2',
  '  exit 7',
  'fi',
  'safe=$(printf "%s" "$id" | tr "/:" "__")',
  'echo "Fetching: $id"',
  'case "$FAKE_MODE" in',
  '  sleep) sleep 5; exit 0 ;;',
  '  exitnz) echo "boom" >&2; exit 3 ;;',
  '  broken) echo "Traceback (most recent call last):"; exit 0 ;;',
  'esac',
  'if [ "$FAKE_MODE" = "nopdf" ]; then',
  '  cat <<NOJSON',
  '{',
  '  "status": "failed",',
  '  "quality": "none",',
  '  "reason": "no_open_access_pdf",',
  '  "next_action": { "message": "Try the browser route" }',
  '}',
  'NOJSON',
  '  exit 0',
  'fi',
  'path="$out/$safe.pdf"',
  'case "$FAKE_MODE" in',
  '  small) printf "%%PDF-1.4 tiny" > "$path" ;;',
  '  html) printf "<!doctype html><html>login</html>" > "$path" ;;',
  '  *)',
  '    {',
  '      printf "%%PDF-1.4\\n"',
  '      i=0',
  '      while [ $i -lt 400 ]; do printf "padding line %s\\n" "$i"; i=$((i+1)); done',
  '      printf "%%%%EOF\\n"',
  '    } > "$path" ;;',
  'esac',
  'cat <<EOF',
  '{',
  '  "status": "success",',
  '  "quality": "text_and_pdf",',
  '  "reason": "",',
  '  "paper": {',
  '    "doi": "$id",',
  '    "title": "A fake paper",',
  '    "source": "open_access",',
  '    "pdf_path": "$path"',
  '  }',
  '}',
  'EOF',
  'echo "PDF saved to: $path"',
  'echo "Source: open_access"',
].join('\n'), { mode: 0o755 })

const papersConfig = join(work, 'instsci-config.json')

/** Seams that keep the run away from the real `~/.instsci/config.json`. */
function paperSeams(mode: string, configPath: string = papersConfig): {
  cli: string
  configPath: string
  env: NodeJS.ProcessEnv
} {
  return { cli: fakeInstsci, configPath, env: { ...process.env, FAKE_MODE: mode } }
}

const papersWithEmail = (): Context => harness({}, work, { THU_PAPER_EMAIL: 'me@example.com' }).ctx

/** Drive the paper tool through the real `apply` with one config. */
async function papersCall(
  config: unknown,
  secrets: Record<string, string>,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const local = harness({}, papersWork, secrets)
  apply(local.ctx, config)
  const tool = local.tools.find(item => item.name === 'thu_paper_fetch')
  assert.ok(tool !== undefined, 'the paper tool registers')
  try {
    return await tool.execute(args, exec)
  } finally {
    local.dispose()
  }
}

const noEmail = await fetchPaper(harness({}, work).ctx, { ...bare }, work, { identifier: '10.5555/fake.paper' }, signal, paperSeams('default'))
assert.equal(noEmail.ok, false)
assert.equal(noEmail.ok ? '' : noEmail.reason, 'missing-credential', 'the email is a hard precondition')

const fetched = await fetchPaper(papersWithEmail(), { ...bare }, work, { identifier: '10.5555/fake.paper' }, signal, paperSeams('default'))
assert.ok(fetched.ok, `a successful fetch reports ok: ${JSON.stringify(fetched)}`)
assert.equal(fetched.path, join(work, 'thu-downloads', 'papers', '10.5555_fake.paper.pdf'))
assert.equal(fetched.title, 'A fake paper')
assert.equal(fetched.status, 'success')
assert.ok((fetched.bytes ?? 0) > 5_000, 'the whole PDF is copied out, not the CLI text')

const writtenConfig = JSON.parse(await readFile(papersConfig, 'utf8')) as {
  email: string
  school: string
  institution_name_zh: string
  institution_name_en: string
  carsi_idp_name: string
}
assert.equal(writtenConfig.email, 'me@example.com', 'the credential email reaches the CLI config')
assert.equal(writtenConfig.school, '清华大学', 'the campus gateway table is keyed by the Chinese name')
assert.equal(writtenConfig.institution_name_zh, '清华大学', 'the login pages get the local name too')
assert.equal(writtenConfig.institution_name_en, 'Tsinghua University', 'publisher login pages are matched against the English name')
assert.equal(writtenConfig.carsi_idp_name, 'Tsinghua University', 'the CARSI list is searched with the English name')
assert.equal(((await stat(papersConfig)).mode & 0o777), 0o600, 'the CLI config is private')

const second = await fetchPaper(papersWithEmail(), { ...bare }, work, { identifier: '10.5555/fake.paper' }, signal, paperSeams('default'))
assert.ok(second.ok)
assert.equal(second.path, join(work, 'thu-downloads', 'papers', '10.5555_fake.paper-1.pdf'), 'a second run does not clobber the first')

const replaced = await fetchPaper(papersWithEmail(), { ...bare }, work, { identifier: '10.5555/fake.paper', overwrite: true }, signal, paperSeams('default'))
assert.ok(replaced.ok)
assert.equal(replaced.path, join(work, 'thu-downloads', 'papers', '10.5555_fake.paper.pdf'), 'overwrite keeps the name')

const doiPdf = await fetchPaper(papersWithEmail(), { ...bare }, work, { identifier: '10.1234/test.1' }, signal, paperSeams('default'))
assert.ok(doiPdf.ok)
assert.equal(doiPdf.path, join(work, 'thu-downloads', 'papers', '10.1234_test.1.pdf'), 'a DOI is made filesystem safe')

const keptConfig = join(work, 'instsci-kept.json')
await writeFile(keptConfig, JSON.stringify({ school: '北京大学', email: 'other@example.com' }))
const kept = await fetchPaper(harness({}, work).ctx, { ...bare }, work, { identifier: '10.5555/fake.paper' }, signal, paperSeams('default', keptConfig))
assert.ok(kept.ok)
const keptWritten = JSON.parse(await readFile(keptConfig, 'utf8')) as { school: string; email: string; carsi_idp_name: string }
assert.equal(keptWritten.school, '北京大学', 'an institution already on disk wins over the default')
assert.equal(keptWritten.email, 'other@example.com', 'an address already on disk is kept')
assert.equal(keptWritten.carsi_idp_name, 'Tsinghua University', 'a name the file does not carry is still filled in')

const smallPdf = await fetchPaper(papersWithEmail(), { ...bare }, work, { identifier: '10.5555/fake.paper' }, signal, paperSeams('small'))
assert.equal(smallPdf.ok ? '' : smallPdf.reason, 'invalid-pdf')

const htmlPdf = await fetchPaper(papersWithEmail(), { ...bare }, work, { identifier: '10.5555/fake.paper' }, signal, paperSeams('html'))
assert.equal(htmlPdf.ok ? '' : htmlPdf.reason, 'invalid-pdf')

const broken = await fetchPaper(papersWithEmail(), { ...bare }, work, { identifier: '10.5555/fake.paper' }, signal, paperSeams('broken'))
assert.equal(broken.ok ? '' : broken.reason, 'unparseable-output')

const exitNonZero = await fetchPaper(papersWithEmail(), { ...bare }, work, { identifier: '10.5555/fake.paper' }, signal, paperSeams('exitnz'))
assert.equal(exitNonZero.ok ? '' : exitNonZero.reason, 'exit-nonzero')
assert.ok((exitNonZero.ok ? '' : exitNonZero.log ?? '').includes('boom'), 'the CLI tail reaches the failure')

const noPdfPath = await fetchPaper(papersWithEmail(), { ...bare }, work, { identifier: '10.5555/fake.paper' }, signal, paperSeams('nopdf'))
assert.equal(noPdfPath.ok ? '' : noPdfPath.reason, 'no-pdf')
assert.ok((noPdfPath.ok ? '' : noPdfPath.message).includes('Try the browser route'), 'the CLI next step is relayed')

const missingCli = await papersCall({ paperCli: join(work, 'nope', 'instsci') }, { THU_PAPER_EMAIL: 'me@example.com' }, { identifier: '10.5555/fake.paper' })
assert.equal(missingCli.reason, 'cli-missing', 'an unset path is reported, not silently skipped')

const slowCli = paperSeams('sleep')
const hung = await spawnWithDeadline(fakeInstsci, ['fetch', 'x'], { cwd: papersWork, env: { ...slowCli.env, COLUMNS: '100000', NO_COLOR: '1' }, timeoutMs: 300, signal })
assert.equal(hung.timedOut, true, 'a deadline stops the child')

const controller = new AbortController()
const pendingKill = spawnWithDeadline(fakeInstsci, ['fetch', 'x'], { cwd: papersWork, env: { ...slowCli.env, COLUMNS: '100000', NO_COLOR: '1' }, timeoutMs: 60_000, signal: controller.signal })
setTimeout(() => { controller.abort() }, 200)
assert.equal((await pendingKill).cancelled, true, 'cancellation stops the child')

assert.equal(extractJson('Fetching: 1\n{\n  "a": 1\n}\nPDF saved to: x'), '{\n  "a": 1\n}')
assert.equal(extractJson('no json here'), undefined)
const pdfBytes = (body: string): Uint8Array => new TextEncoder().encode(body)
assert.equal(pdfProblem(new Uint8Array()), 'empty')
assert.equal(pdfProblem(pdfBytes('<html>hi</html>')), 'html_response')
assert.equal(pdfProblem(pdfBytes('%PDF-1.4 tiny')), 'too_small')
assert.equal(pdfProblem(pdfBytes('x'.repeat(6_000))), 'missing_pdf_header')
assert.equal(pdfProblem(pdfBytes(`%PDF-1.4\n${'x'.repeat(6_000)}\n%%EOF\n`)), undefined)
assert.equal(pdfProblem(pdfBytes(`%PDF-1.4\n\uFFFD${'x'.repeat(6_000)}\n%%EOF\n`)), 'corrupt_pdf_header')
assert.equal(pdfProblem(pdfBytes(`%PDF-1.4\n${'x'.repeat(100)}%%EOF\n${'y'.repeat(9_000)}`)), 'early_eof_with_trailing_payload')
assert.equal(paperFileName('10.1103/PhysRevLett.116.061102', null), '10.1103_PhysRevLett.116.061102.pdf')
assert.equal(paperFileName(null, '2401.01234'), '2401.01234.pdf')
assert.equal(paperFileName('', null), 'paper.pdf')
assert.equal(arxivOf('arXiv:2401.01234v2'), '2401.01234')
assert.equal(arxivOf('https://arxiv.org/abs/2401.01234'), '2401.01234')
assert.equal(arxivOf('10.1103/PhysRevLett.116.061102'), null)
assert.equal(await findOnPath('this-program-does-not-exist-xyz', { PATH: papersWork }), undefined)

let flakyHits = 0
const arxivServer = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  if (url.pathname === '/pdf/2404.00001') {
    flakyHits += 1
    if (flakyHits === 1) {
      // A proxy blip: the first connection dies mid-handshake.
      request.socket.destroy()
      return
    }
    const body = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(6_000, 0x20), Buffer.from('\n%%EOF\n')])
    response.writeHead(200, { 'content-type': 'application/pdf' }).end(body)
    return
  }
  if (url.pathname === '/pdf/2401.01234') {
    const body = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(6_000, 0x20), Buffer.from('\n%%EOF\n')])
    response.writeHead(200, { 'content-type': 'application/pdf' }).end(body)
    return
  }
  if (url.pathname === '/pdf/2402.00001') {
    response.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><html>login</html>')
    return
  }
  response.writeHead(404).end()
})
await new Promise<void>(resolve => { arxivServer.listen(0, '127.0.0.1', resolve) })
const arxivOrigin = `http://127.0.0.1:${String((arxivServer.address() as AddressInfo).port)}`

try {
  // No CLI at all: the arXiv route must stand on its own.
  const noCli = { ...bare, paperCli: '/nonexistent/instsci' }
  const fromId = await fetchPaper(harness({}, work).ctx, noCli, work, { identifier: '2401.01234' }, signal, { arxivOrigin })
  assert.ok(fromId.ok, `a bare arXiv id is fetched without the CLI: ${JSON.stringify(fromId)}`)
  assert.equal(fromId.path, join(work, 'thu-downloads', 'papers', '2401.01234.pdf'))
  assert.equal(fromId.source, 'arxiv')
  assert.equal(fromId.quality, 'pdf_only', 'no text extraction happens on the direct route')
  assert.ok((fromId.bytes ?? 0) > 5_000)

  const versioned = await fetchPaper(harness({}, work).ctx, noCli, work, { identifier: 'arXiv:2401.01234v2' }, signal, { arxivOrigin })
  assert.ok(versioned.ok)
  assert.equal(versioned.arxivId, '2401.01234', 'a version suffix is stripped from the id')
  assert.equal(versioned.path, join(work, 'thu-downloads', 'papers', '2401.01234-1.pdf'), 'the same paper keeps a second name')
  assert.equal(versioned.title, 'arXiv 2401.01234')

  const overwritten = await fetchPaper(harness({}, work).ctx, noCli, work, { identifier: 'https://arxiv.org/abs/2401.01234', overwrite: true }, signal, { arxivOrigin })
  assert.ok(overwritten.ok)
  assert.equal(overwritten.path, join(work, 'thu-downloads', 'papers', '2401.01234.pdf'), 'overwrite keeps the name')

  const wrongBytes = await fetchPaper(harness({}, work).ctx, noCli, work, { identifier: '2402.00001' }, signal, { arxivOrigin })
  assert.equal(wrongBytes.ok ? '' : wrongBytes.reason, 'invalid-pdf', 'a login page is not saved as a paper')

  const missing = await fetchPaper(harness({}, work).ctx, noCli, work, { identifier: '2403.99999' }, signal, { arxivOrigin })
  assert.equal(missing.ok ? '' : missing.reason, 'exit-nonzero', 'a 404 from arXiv is reported as such')

  const relative = await fetchPaper(harness({}, work).ctx, { ...noCli, paperDir: 'papers-out' }, work, { identifier: '2401.01234' }, signal, { arxivOrigin })
  assert.ok(relative.ok, `a relative paperDir is honoured: ${JSON.stringify(relative)}`)
  assert.equal(relative.path, join(work, 'papers-out', '2401.01234.pdf'), 'a relative paperDir counts from the workspace')

  const elsewhere = await mkdtemp(join(tmpdir(), 'thu-papers-dir-'))
  const absolute = await fetchPaper(harness({}, work).ctx, { ...noCli, paperDir: elsewhere }, work, { identifier: '2401.01234' }, signal, { arxivOrigin })
  assert.ok(absolute.ok)
  assert.equal(dirname(absolute.path), elsewhere, 'an absolute paperDir is used as written')
  await rm(elsewhere, { recursive: true, force: true })

  const retried = await fetchPaper(harness({}, work).ctx, noCli, work, { identifier: '2404.00001' }, signal, { arxivOrigin })
  assert.ok(retried.ok, `a reset connection is retried once: ${JSON.stringify(retried)}`)
  assert.equal(flakyHits, 2, 'exactly one retry')

  assert.equal(paperDirectory(work, { ...bare, paperDir: '' }), join(work, 'thu-downloads', 'papers'))
  assert.equal(paperDirectory(work, { ...bare, paperDir: '~/Papers' }), join(homedir(), 'Papers'))
  assert.equal(paperDirectory(work, { ...bare, paperDir: '/tmp/lit' }), '/tmp/lit')
} finally {
  arxivServer.close()
}

const searchServer = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  if (url.pathname !== '/graph/v1/paper/search') {
    response.writeHead(404).end()
    return
  }
  const query = url.searchParams.get('query') ?? ''
  if (query === 'rate') {
    response.writeHead(429, { 'retry-after': '7' }).end('{}')
    return
  }
  if (query === 'bad') {
    response.writeHead(400).end('{}')
    return
  }
  response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
    total: 2,
    data: [
      { title: 'Hits', authors: [{ name: 'A' }, { name: 'B' }], year: 2020, venue: 'J', externalIds: { DOI: '10.1/x' }, citationCount: 5, abstract: 'abs', url: 'https://x' },
      { authors: [] },
    ],
  }))
})
await new Promise<void>(resolve => { searchServer.listen(0, '127.0.0.1', resolve) })
const searchOrigin = `http://127.0.0.1:${String((searchServer.address() as AddressInfo).port)}`

try {
  const hits = await searchPapers({ query: 'kv cache', limit: 5 }, { timeoutMs: 5_000, signal, origin: searchOrigin })
  assert.ok(hits.ok, 'a 200 response maps to hits')
  assert.equal(hits.results.length, 1, 'a record without a title is dropped')
  assert.equal(hits.results[0]?.doi, '10.1/x')
  assert.deepEqual(hits.results[0]?.authors, ['A', 'B'])

  const limited = await searchPapers({ query: 'rate', limit: 5 }, { timeoutMs: 5_000, signal, origin: searchOrigin })
  assert.ok(!limited.ok)
  assert.equal(limited.reason, 'rate-limited')
  assert.equal(limited.retryAfterSec, 7, 'the retry hint is read from the header')

  const rejected = await searchPapers({ query: 'bad', limit: 5 }, { timeoutMs: 5_000, signal, origin: searchOrigin })
  assert.ok(!rejected.ok)
  assert.equal(rejected.reason, 'bad-request')
} finally {
  await new Promise<void>(resolve => { searchServer.close(() => resolve()) })
}

// ---------------------------------------------------------------------------
// Cloud client against a loopback Seafile stand-in
// ---------------------------------------------------------------------------

const SHARE_KEY = 'abc12345'
const DIRENTS: Record<string, unknown[]> = {
  '/': [
    { file_name: 'a.pdf', file_type: 'file', size: 5 },
    { file_name: 'sub', file_type: 'dir', size: 0 },
  ],
  '/sub': [{ file_name: 'b.txt', file_type: 'file', size: 3 }],
}
const BODIES: Record<string, string> = { '/a.pdf': 'hello', '/sub/b.txt': 'abc' }

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  if (url.pathname.startsWith('/api/v2.1/share-links/')) {
    const path = url.searchParams.get('path') ?? '/'
    const dirents = DIRENTS[path]
    if (dirents === undefined) {
      response.writeHead(404).end()
      return
    }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(dirents))
    return
  }
  if (url.pathname.startsWith('/d/')) {
    const body = BODIES[url.searchParams.get('p') ?? '']
    if (body === undefined) {
      response.writeHead(404).end()
      return
    }
    response.writeHead(200, { 'content-type': 'application/octet-stream' }).end(body)
    return
  }
  response.writeHead(400).end()
})
await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
const port = (server.address() as AddressInfo).port
const origin = `http://127.0.0.1:${String(port)}`

try {
  const target = { shareKey: SHARE_KEY, path: '/' }
  const listed = await listDirectory(target, { origin, timeoutMs: 5_000, signal })
  assert.deepEqual(listed.map(entry => entry.type), ['dir', 'file'], 'directories sort first')
  assert.deepEqual(listed.map(entry => entry.path), ['/sub', '/a.pdf'])

  const walked = await walkFiles(target, { origin, timeoutMs: 5_000, signal })
  assert.deepEqual(walked.map(entry => entry.path).sort(), ['/a.pdf', '/sub/b.txt'])

  const nested = await listDirectory({ shareKey: SHARE_KEY, path: '/sub' }, { origin, timeoutMs: 5_000, signal })
  assert.equal(nested[0]?.name, 'b.txt')

  await assert.rejects(
    listDirectory({ shareKey: SHARE_KEY, path: '/missing' }, { origin, timeoutMs: 5_000, signal }),
    (error: unknown) => error instanceof CloudError && error.reason === 'not-found',
  )

  const root = join(work, 'share')
  const result = await downloadShareFiles(target, { origin, root, concurrency: 2, timeoutMs: 5_000, signal })
  assert.equal(result.downloaded.length, 2)
  assert.equal(result.failed.length, 0)
  assert.equal(result.totalBytes, 8)
  assert.equal(await readFile(join(root, 'a.pdf'), 'utf8'), 'hello')
  assert.equal(await readFile(join(root, 'sub', 'b.txt'), 'utf8'), 'abc', 'directory structure is preserved')

  const filtered = await downloadShareFiles(target, { origin, root: join(work, 'filtered'), pattern: '.pdf', concurrency: 1, timeoutMs: 5_000, signal })
  assert.deepEqual(filtered.downloaded.map(item => item.name), ['a.pdf'])

  const emptyRun = await downloadShareFiles(target, { origin, root: join(work, 'none'), pattern: '.nosuch', concurrency: 1, timeoutMs: 5_000, signal })
    .then(() => undefined, (error: unknown) => error)
  assert.equal(emptyRun instanceof CloudError && emptyRun.reason, 'empty-directory')

  const single = await downloadShareFiles({ shareKey: SHARE_KEY, path: '/a.pdf' }, { origin, root: join(work, 'single'), concurrency: 1, timeoutMs: 5_000, signal })
  assert.equal(single.downloaded[0]?.bytes, 5, 'a file path falls back to a single transfer')

  assert.ok(fileDownloadUrl(SHARE_KEY, '/a.pdf', origin).includes('dl=1'))
} finally {
  await new Promise<void>(resolve => { server.close(() => resolve()) })
  await rm(work, { recursive: true, force: true })
}

console.log('host-smoke: ok')