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
import { access, chmod, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import type { ThuOptions } from './config.ts'
import { reservesCliPath } from './config.ts'
import { sharedFingerprint } from './identity.ts'
import { AUTOMAD_SPEC, automadBundled, automadSpec, currentProfile, installAutomad } from './automad.ts'

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
 */
function credentialFields(options: ThuOptions) {
  return [
    { id: 'username', ref: credentialRef(options.usernameRef), secret: false, shared: false },
    { id: 'password', ref: credentialRef(options.passwordRef), secret: true, shared: false },
    { id: 'fingerprint', ref: credentialRef('THU_LEARN_FINGERPRINT'), secret: true, shared: true },
    { id: 'cookie', ref: credentialRef('THU_LEARN_COOKIE'), secret: true, shared: false },
    { id: 'reserves-token', ref: credentialRef('THU_RESERVES_TOKEN'), secret: true, shared: false },
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
  const automadInstalled = profile === undefined ? undefined : await automadSpec(profile)
  return {
    tools: [{
      id: 'reserves',
      installed: await reservesInstalled(reservesCliPath(options)),
      path: reservesCliPath(options),
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
