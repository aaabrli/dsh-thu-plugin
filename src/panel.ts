/**
 * Panel routes for the light UI.
 *
 * The settings page downloads the reserves CLI onto this machine and sets Learn
 * credentials. It never lists or downloads course files — those stay on the
 * session tools. Secret values are written through `credentials.set` and never
 * returned: a panel read only reports configured / writable.
 * @module dsh-thu-plugin/panel
 */

import { spawn } from 'node:child_process'
import { createWriteStream, existsSync } from 'node:fs'
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import type { ThuOptions } from './config.ts'
import { reservesCliPath } from './config.ts'
import { sharedFingerprint } from './identity.ts'
import { AUTOMAD_SPEC, automadBundled, automadSpec, currentProfile, installAutomad } from './automad.ts'
import { findOnPath, findPaperCli } from './papers/fetch.ts'

/** Official release the install button fetches. GPL binary, never vendored. */
const RESERVES_RELEASE = 'v4.0.1'
const RESERVES_ASSET: Record<string, string> = {
  darwin: 'downloader-macos-latest-py3.9.zip',
  linux: 'downloader-ubuntu-latest-py3.9.zip',
  win32: 'downloader-windows-latest-py3.9.zip',
}

/**
 * Credentials the settings page may set. Values never leave the host.
 *
 * `username` / `password` point at the same references `dsh-thu-automad` uses,
 * so one entry feeds both plugins. `fingerprint` is an override: when it is
 * empty the device id stored in the shared session record is used instead, and
 * `shared` reports whether that record currently holds one.
 *
 * The reserves token is here because the CLI's own login path opens a browser,
 * which a tool call cannot do: the token has to be pasted instead.
 *
 * The paper email is not a secret, but it is per-person and the CLI prompts for
 * it on stdin when it has none, so it is stored the same way as the rest.
 */
function credentialFields(options: ThuOptions) {
  return [
    { id: 'username', ref: credentialRef(options.usernameRef), secret: false, shared: false },
    { id: 'password', ref: credentialRef(options.passwordRef), secret: true, shared: false },
    { id: 'fingerprint', ref: credentialRef('THU_LEARN_FINGERPRINT'), secret: true, shared: true },
    { id: 'cookie', ref: credentialRef('THU_LEARN_COOKIE'), secret: true, shared: false },
    { id: 'reserves-token', ref: credentialRef('THU_RESERVES_TOKEN'), secret: true, shared: false },
    { id: 'paper-email', ref: credentialRef(options.paperEmailRef), secret: false, shared: false },
  ] as const
}

/** One field the settings page may display. */
export interface PanelField {
  id: string
  configured: boolean
  writable: boolean
  secret: boolean
  /** Whether the shared session record already holds a value for this field. */
  shared?: boolean
}

/** Snapshot the settings page polls. No secret values. */
export interface PanelSnapshot {
  tools: Array<
    | { id: 'reserves'; installed: boolean; path: string }
    | { id: 'papers'; installed: boolean; path: string | null }
    | {
      id: 'automad'
      /** The profile whose plugin list the button edits; empty when undetectable. */
      profile: string
      /** The git spec the button installs. */
      spec: string
      /** Recorded dependency spec, or empty when the profile does not list it. */
      installed: string
      /** Whether `dsh.profile.bundles` also names it; false means installed but not loaded. */
      bundled: boolean
    }
  >
  fields: PanelField[]
}

/** In-memory install task. Lost when the process ends. */
export interface InstallTask {
  taskId: string
  state: 'running' | 'done' | 'failed'
  /** Latest line of progress, for the panel to show while the task runs. */
  progress?: string
  error?: string
  /** Tail of the CLI output, for the panel to show when something went wrong. */
  log?: string
  /** Set when the install needs a restart of the host before it takes effect. */
  restartRequired?: boolean
}

const tasks = new Map<string, InstallTask>()

/**
 * Whether the configured reserves CLI path is reachable.
 * @param path - configured CLI path; empty means not installed.
 * @returns true when the path exists.
 */
export async function reservesInstalled(path: string): Promise<boolean> {
  if (path.length === 0) return false
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/**
 * Read the settings page snapshot. Describes credentials; never resolves them.
 * @param ctx - plugin context.
 * @param options - validated options.
 * @returns tools and field presence.
 */
export async function readPanel(ctx: Context, options: ThuOptions): Promise<PanelSnapshot> {
  const stored = await sharedFingerprint(ctx)
  const fields = await Promise.all(credentialFields(options).map(async field => {
    const info = await ctx.credentials.describe(field.ref)
    const shared = field.shared && stored !== undefined
    return {
      id: field.id,
      configured: info.configured || shared,
      writable: info.writable,
      secret: field.secret,
      ...(shared ? { shared: true } : {}),
    }
  }))
  const profile = await currentProfile()
  const papersCli = await findPaperCli(options)
  const automadInstalled = profile === undefined ? undefined : await automadSpec(profile)
  return {
    tools: [{
      id: 'reserves',
      installed: await reservesInstalled(reservesCliPath(options)),
      path: reservesCliPath(options),
    }, {
      id: 'papers',
      installed: papersCli !== undefined,
      path: papersCli ?? null,
    }, {
      id: 'automad',
      profile: profile?.name ?? '',
      spec: AUTOMAD_SPEC,
      installed: automadInstalled ?? '',
      bundled: profile === undefined ? false : await automadBundled(profile),
    }],
    fields,
  }
}

/**
 * Start installing the reserves CLI. One running task at a time.
 * @param options - validated options; `reservesCli` is where the binary lands.
 * @returns the task, or a domain failure when the path or platform is missing.
 */
export function startInstall(options: ThuOptions): InstallTask | { ok: false; reason: string } {
  const asset = RESERVES_ASSET[process.platform]
  if (asset === undefined) {
    return { ok: false, reason: `no reserves build for ${process.platform}` }
  }
  for (const task of tasks.values()) {
    if (task.state === 'running') return task
  }
  const task: InstallTask = { taskId: `reserves-${Date.now().toString(36)}`, state: 'running' }
  tasks.set(task.taskId, task)
  void runInstall(task, reservesCliPath(options), asset)
  return task
}

/**
 * Start installing `dsh-thu-automad` into the running profile.
 *
 * The install goes through the CLI (`plugin --profile <name> add <spec>`), which
 * also reconciles `dsh.profile.bundles`; the panel never edits a profile on its
 * own. A success still needs a restart before the plugin loads.
 * @returns the task, or a domain failure when the profile cannot be found.
 */
export async function startAutomadInstall(): Promise<InstallTask | { ok: false; reason: string }> {
  const profile = await currentProfile()
  if (profile === undefined) return { ok: false, reason: 'profile-not-found' }
  if (!existsSync(join(profile.dir, 'package.json'))) return { ok: false, reason: 'profile-not-found' }
  for (const task of tasks.values()) {
    if (task.state === 'running') return task
  }
  const task: InstallTask = { taskId: `automad-${Date.now().toString(36)}`, state: 'running' }
  tasks.set(task.taskId, task)
  void runAutomadInstall(task, profile)
  return task
}

/**
 * Run the install and record its outcome on the task. Never throws: the panel
 * polls the task, so an error has to land there too.
 * @param task - task to update in place.
 * @param profile - profile to install into.
 */
async function runAutomadInstall(task: InstallTask, profile: { name: string; dir: string }): Promise<void> {
  try {
    const result = await installAutomad(profile, log => { task.log = log.slice(-4_000) })
    if (!result.ok) {
      task.state = 'failed'
      task.error = `plugin add exited ${result.code ?? 'unknown'}`
      return
    }
    task.state = 'done'
    task.restartRequired = true
  } catch (error) {
    task.state = 'failed'
    task.error = error instanceof Error ? error.message : String(error)
  }
}

/**
 * Read one install task.
 * @param taskId - id returned by {@link startInstall}.
 * @returns the task, or undefined when unknown.
 */
export function readInstall(taskId: string): InstallTask | undefined {
  return tasks.get(taskId)
}

/**
 * Write one Learn credential. Empty clears it. The value is not returned.
 * @param ctx - plugin context.
 * @param options - validated options, carrying the shared reference names.
 * @param id - field id from {@link credentialFields}.
 * @param value - new value, or empty to unset.
 * @returns a domain result. Never includes the value.
 */
export async function writeCredential(
  ctx: Context,
  options: ThuOptions,
  id: string,
  value: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const field = credentialFields(options).find(item => item.id === id)
  if (field === undefined) return { ok: false, reason: 'unknown-field' }
  const info = await ctx.credentials.describe(field.ref)
  if (!info.writable) return { ok: false, reason: 'not-writable' }
  const trimmed = value.trim()
  if (trimmed.length === 0) {
    await ctx.credentials.unset(field.ref)
    return { ok: true }
  }
  await ctx.credentials.set(field.ref, trimmed)
  return { ok: true }
}

/** Field id → credential ref, for tests. */
export function fieldRef(options: ThuOptions, id: string): CredentialRef | undefined {
  return credentialFields(options).find(item => item.id === id)?.ref
}

/**
 * Download the official zip, extract the `downloader` binary, and move it into place.
 * @param task - task to update in place.
 * @param destination - absolute path the binary should land at.
 * @param asset - release asset name for this platform.
 */
async function runInstall(task: InstallTask, destination: string, asset: string): Promise<void> {
  const url = `https://github.com/libthu/reserves-lib-tsinghua-downloader/releases/download/${RESERVES_RELEASE}/${asset}`
  const scratch = await mkdtemp(join(tmpdir(), 'thu-reserves-'))
  try {
    const zipPath = join(scratch, 'downloader.zip')
    const response = await fetch(url)
    if (!response.ok || response.body === null) {
      throw new Error(`download failed: HTTP ${response.status}`)
    }
    const reader = response.body.getReader()
    const sink = createWriteStream(zipPath)
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        if (!sink.write(chunk.value)) {
          await new Promise<void>(resolve => { sink.once('drain', () => { resolve() }) })
        }
      }
    } finally {
      sink.end()
      reader.releaseLock()
    }
    await extractDownloader(zipPath, scratch)
    const binary = join(scratch, 'downloader')
    await access(binary)
    await chmod(binary, 0o755)
    await mkdir(dirnameOf(destination), { recursive: true })
    await moveFile(binary, destination)
    task.state = 'done'
  } catch (error) {
    task.state = 'failed'
    task.error = error instanceof Error ? error.message : String(error)
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

/**
 * Unzip and keep only the `downloader` entry. The zip is a GPL binary; we do not vendor it.
 * @param zipPath - downloaded archive.
 * @param scratch - directory to extract into.
 */
async function extractDownloader(zipPath: string, scratch: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('unzip', ['-o', '-j', zipPath, 'downloader', '-d', scratch], {
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-500)
    })
    child.on('error', reject)
    child.on('close', code => {
      if (code === 0) resolve()
      else reject(new Error(stderr.trim() || `unzip exited ${code ?? 'unknown'}`))
    })
  })
}

/** Parent directory of a path, without pulling path.dirname into the hot import set. */
function dirnameOf(path: string): string {
  const index = path.lastIndexOf('/')
  return index <= 0 ? homedir() : path.slice(0, index)
}

/**
 * Move a file, falling back to copy when the temp dir is on another volume.
 * @param from - source path.
 * @param to - destination path.
 */
async function moveFile(from: string, to: string): Promise<void> {
  const { rename, copyFile } = await import('node:fs/promises')
  try {
    await rename(from, to)
  } catch {
    await copyFile(from, to)
    await chmod(to, 0o755)
  }
}

/** Upstream project the paper install button fetches. MIT, but a Python app: installed, never imported. */
const PAPERS_SPEC = 'git+https://github.com/Rimagination/instsci.git'
/** Python the CLI is installed under: its browser path is 3.10–3.13 only, and 3.14 is the local default. */
const PAPERS_PYTHON = '3.13'
/** A first install also downloads a browser runtime, so it gets its own ceiling. */
const PAPERS_INSTALL_TIMEOUT_MS = 900_000
/** Official uv builds, published as `<target>.tar.gz` under this prefix. */
const UV_RELEASE_BASE = 'https://github.com/astral-sh/uv/releases/latest/download'
/** One archive download; a dead network must not hang the install forever. */
const UV_TIMEOUT_MS = 300_000

/**
 * The uv release this machine matches, in uv's own target naming.
 * @returns e.g. `aarch64-apple-darwin`, or undefined on an unsupported platform.
 */
function uvTarget(): string | undefined {
  const arch = process.arch === 'arm64' ? 'aarch64' : process.arch === 'x64' ? 'x86_64' : undefined
  const os = process.platform === 'darwin'
    ? 'apple-darwin'
    : process.platform === 'linux' ? 'unknown-linux-gnu' : undefined
  return arch === undefined || os === undefined ? undefined : `${arch}-${os}`
}

/**
 * Start installing the paper CLI, installing uv first when neither installer exists.
 *
 * `uv tool install` and `pipx install` both drop `instsci` in `~/.local/bin`,
 * which is where the fetch tool looks after its own install location; a
 * bootstrapped `uv` lands in that same directory. A bare `pip install` is never
 * attempted: it would target an interpreter this button cannot identify.
 * @returns the task; progress and failure are both recorded on it.
 */
export async function startPapersInstall(): Promise<InstallTask> {
  for (const task of tasks.values()) {
    if (task.state === 'running') return task
  }
  const task: InstallTask = { taskId: `papers-${Date.now().toString(36)}`, state: 'running' }
  tasks.set(task.taskId, task)
  void runPaperInstall(task)
  return task
}

/**
 * One install: find or bootstrap an installer, then install the CLI.
 * Never throws.
 * @param task - task updated in place.
 */
async function runPaperInstall(task: InstallTask): Promise<void> {
  try {
    let runner = await papersInstaller()
    if (runner === undefined) {
      const uv = await bootstrapUv(task)
      if (uv === undefined) {
        task.state = 'failed'
        task.error ??= 'uv could not be installed automatically'
        return
      }
      runner = { name: 'uv', path: uv }
    }
    progressOf(task, `installing the paper CLI with ${runner.name}`)
    // Pinning the interpreter is not cosmetic: on Python 3.14 Playwright's sync
    // API mis-detects a running loop, CloakBrowser refuses to start, and every
    // institutional route ends as `auth_required`. uv fetches a matching
    // interpreter itself, so the pin costs nothing on a machine that lacks it.
    // `--force` is what makes the pin reachable: an install made by an older
    // build (or by hand, on another interpreter) otherwise fails the button with
    // "already installed" and keeps running on the old Python.
    const argv = runner.name === 'uv'
      ? ['tool', 'install', '--force', '--python', PAPERS_PYTHON, PAPERS_SPEC]
      : ['install', '--force', '--python', PAPERS_PYTHON, PAPERS_SPEC]
    const exit = await runInstaller(runner.path, argv, task)
    if (exit.timedOut) {
      task.state = 'failed'
      task.error = `${runner.name} ran longer than ${String(PAPERS_INSTALL_TIMEOUT_MS / 60_000)} minutes and was stopped`
      return
    }
    if (exit.code !== 0) {
      task.state = 'failed'
      task.error = `${runner.name} exited ${String(exit.code ?? 'unknown')}`
      return
    }
    delete task.progress
    task.state = 'done'
  } catch (error) {
    task.state = 'failed'
    task.error = error instanceof Error ? error.message : String(error)
  }
}

/**
 * The first installer this machine has, preferring `uv`.
 * @returns installer name and path, or undefined when neither is present.
 */
async function papersInstaller(): Promise<{ name: 'uv' | 'pipx'; path: string } | undefined> {
  for (const name of ['uv', 'pipx'] as const) {
    for (const directory of [join(homedir(), '.local', 'bin'), join(homedir(), '.cargo', 'bin')]) {
      const candidate = join(directory, name)
      if (existsSync(candidate)) return { name, path: candidate }
    }
    const fromPath = await findOnPath(name)
    if (fromPath !== undefined) return { name, path: fromPath }
  }
  return undefined
}

/**
 * Download the official uv build into `~/.local/bin`.
 *
 * The project's shell installer is not piped through `sh`: one archive from the
 * release page is easier to explain, and the only thing executed afterwards is
 * the binary this function wrote.
 * @param task - task whose progress and error are recorded.
 * @returns the installed path, or undefined with `task.error` set.
 */
async function bootstrapUv(task: InstallTask): Promise<string | undefined> {
  const target = uvTarget()
  if (target === undefined) {
    task.error = `no uv build for ${process.platform}/${process.arch}: install uv or pipx by hand`
    return undefined
  }
  const binDir = join(homedir(), '.local', 'bin')
  const destination = join(binDir, 'uv')
  const work = await mkdtemp(join(tmpdir(), 'dsh-thu-uv-'))
  try {
    const url = `${UV_RELEASE_BASE}/uv-${target}.tar.gz`
    progressOf(task, `no uv or pipx here yet: downloading uv (${target})`)
    const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(UV_TIMEOUT_MS) })
    if (!response.ok) throw new Error(`HTTP ${String(response.status)} from ${url}`)
    const archive = join(work, 'uv.tar.gz')
    await writeFile(archive, Buffer.from(await response.arrayBuffer()))
    const exit = await runInstaller('tar', ['-xzf', archive, '-C', work], task, UV_TIMEOUT_MS)
    if (exit.code !== 0) throw new Error(`tar exited ${String(exit.code ?? 'unknown')}`)
    const extracted = join(work, `uv-${target}`, 'uv')
    if (!existsSync(extracted)) throw new Error(`the archive has no uv-${target}/uv`)
    await mkdir(binDir, { recursive: true })
    await moveFile(extracted, destination)
    await chmod(destination, 0o755)
    progressOf(task, `installed uv at ${destination}`)
    return destination
  } catch (error) {
    task.error = `uv could not be installed: ${error instanceof Error ? error.message : String(error)}`
    return undefined
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

/**
 * Record one progress line.
 * @param task - task being updated.
 * @param message - what is happening now.
 */
function progressOf(task: InstallTask, message: string): void {
  task.progress = message
  task.log = `${task.log ?? ''}${message}\n`.slice(-64_000)
}

/**
 * Run an installer or helper to completion, keeping the tail of its output on the task.
 * @param cli - executable.
 * @param argv - arguments.
 * @param task - task whose log and progress are updated.
 * @param timeoutMs - wall clock before the child is stopped.
 * @returns exit facts; a non-zero exit is not an exception.
 */
async function runInstaller(
  cli: string,
  argv: readonly string[],
  task: InstallTask,
  timeoutMs: number = PAPERS_INSTALL_TIMEOUT_MS,
): Promise<{ code: number | null; timedOut: boolean }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(cli, [...argv], { stdio: ['ignore', 'pipe', 'pipe'] })
    let timedOut = false
    const capture = (chunk: Buffer): void => {
      task.log = `${task.log ?? ''}${chunk.toString()}`.slice(-64_000)
      const line = task.log.split('\n').filter(part => part.trim().length > 0).at(-1)
      if (line !== undefined && line.length <= 200) task.progress = line.trim()
    }
    child.stdout.on('data', capture)
    child.stderr.on('data', capture)
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 5_000).unref()
    }, timeoutMs)
    child.once('error', error => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('close', (code: number | null) => {
      clearTimeout(timer)
      resolve({ code, timedOut })
    })
  })
}
