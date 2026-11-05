/**
 * Install `dsh-thu-automad` into the profile this host is running from.
 *
 * The panel does not edit the profile's `package.json` by hand: the CLI already
 * owns that file. `dsh plugin --profile <name> add <spec>` forwards to pnpm in
 * the profile directory, reconciles `dsh.profile.bundles` after the install, and
 * reports pnpm's own diagnostics — so the button re-runs the CLI instead of
 * re-implementing it.
 *
 * Which CLI to run is a runtime fact, not a constant. A source checkout is
 * started as `node --import tsx/esm apps/cli/src/bin.ts`, an installed one as
 * `node …/@deepseek-ai/dsh/lib/bin.js`, and only some machines have a `dsh` on
 * PATH. Reusing this process's own launcher reproduces whichever form started
 * the app; `dsh` on PATH is the last resort.
 * @module dsh-thu-plugin/automad
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'

/** Package the button installs. Also the key written into `dsh.profile.bundles`. */
export const AUTOMAD_PACKAGE = 'dsh-thu-automad'

/** Where the package comes from. Git, because it is not on the registry. */
export const AUTOMAD_SPEC = 'https://github.com/aaabrli/dsh-thu-automad.git'

/** A pnpm git install builds in the clone; ten minutes is generous, not unbounded. */
const INSTALL_TIMEOUT_MS = 900_000

/** Output kept from the install; the CLI prints diagnostics worth showing. */
const LOG_LIMIT = 64_000

/** Profile this host was started from. */
export interface ProfileInfo {
  name: string
  dir: string
}

/**
 * DSH home, honouring the override the launcher reads.
 * @returns absolute path of the DSH home directory.
 */
export function dshHomeDir(): string {
  const override = process.env.DSH_HOME
  return override !== undefined && override.length > 0 ? resolve(override) : join(homedir(), '.dsh')
}

/**
 * Directory of one profile.
 * @param name - profile name.
 * @returns absolute profile directory.
 */
export function profileDirOf(name: string): string {
  return join(dshHomeDir(), 'profiles', name)
}

/**
 * The profile named on this process's own command line, if any.
 *
 * Both spellings are live: `dsh --profile web` passes a flag, while `dsh web`
 * passes the profile as the first positional argument (the launcher rewrites it
 * into `--profile web`). The entry script path is also in argv, so a positional
 * only counts when a directory of that name actually exists.
 * @returns the profile name, or undefined when argv names none.
 */
function profileFromArgv(): string | undefined {
  const argv = process.argv.slice(1)
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === undefined) continue
    if (argument === '--profile') return argv[index + 1]
    if (argument.startsWith('--profile=')) return argument.slice('--profile='.length)
    if (argument.startsWith('-')) continue
    if (existsSync(profileDirOf(argument))) return argument
  }
  return undefined
}

/**
 * The profile that already lists this plugin as a dependency.
 *
 * This is the fallback when argv carries no profile (a bare `dsh web` started
 * from a wrapper): the host cannot run unless its own package is installed in
 * the profile, so the directory that names it is the answer.
 * @returns the profile name, or undefined when no profile lists the plugin.
 */
async function profileFromDependencies(): Promise<string | undefined> {
  const root = join(dshHomeDir(), 'profiles')
  let entries: string[]
  try {
    const { readdir } = await import('node:fs/promises')
    entries = await readdir(root)
  } catch {
    return undefined
  }
  for (const entry of entries.sort()) {
    try {
      const manifest: unknown = JSON.parse(await readFile(join(root, entry, 'package.json'), 'utf8'))
      if (typeof manifest !== 'object' || manifest === null) continue
      const dependencies = (manifest as { dependencies?: unknown }).dependencies
      if (typeof dependencies !== 'object' || dependencies === null) continue
      if (Object.hasOwn(dependencies, 'dsh-thu-plugin')) return entry
    } catch {
      // Not a profile, or not readable: keep looking.
    }
  }
  return undefined
}

/**
 * Resolve the profile this host is running from.
 * @returns the profile, or undefined when neither argv nor any manifest names one.
 */
export async function currentProfile(): Promise<ProfileInfo | undefined> {
  const name = profileFromArgv() ?? await profileFromDependencies()
  return name === undefined ? undefined : { name, dir: profileDirOf(name) }
}

/** How to re-run this installation's CLI. */
export interface Launcher {
  command: string
  args: string[]
  /** Human-readable form, for the log line. */
  label: string
}

/**
 * The command that re-runs this installation's CLI.
 *
 * Electron hosts spell `process.execPath` as the app binary, so they are left to
 * the PATH fallback instead of being handed a flag set that means something
 * else there.
 * @returns the launcher; `dsh` on PATH when this process cannot describe itself.
 */
export function launcher(): Launcher {
  const entry = process.argv[1]
  const selfHosted = entry !== undefined
    && process.versions.electron === undefined
    && /(?:^|[\\/])(?:bin|dsh)(?:\.(?:js|mjs|cjs|ts))?$/u.test(entry)
  if (selfHosted) {
    const absolute = resolve(entry)
    if (existsSync(absolute)) {
      return { command: process.execPath, args: [...process.execArgv, absolute], label: basename(absolute) }
    }
  }
  return { command: 'dsh', args: [], label: 'dsh' }
}

/**
 * Whether the profile's manifest already lists the package.
 * @param profile - profile to read.
 * @returns the recorded spec, or undefined when the profile does not list it.
 */
export async function automadSpec(profile: ProfileInfo): Promise<string | undefined> {
  try {
    const manifest: unknown = JSON.parse(await readFile(join(profile.dir, 'package.json'), 'utf8'))
    if (typeof manifest !== 'object' || manifest === null) return undefined
    const dependencies = (manifest as { dependencies?: unknown }).dependencies
    if (typeof dependencies !== 'object' || dependencies === null) return undefined
    const spec = (dependencies as Record<string, unknown>)[AUTOMAD_PACKAGE]
    return typeof spec === 'string' ? spec : undefined
  } catch {
    return undefined
  }
}

/**
 * Whether the profile's bundle list also carries the package. Listing the
 * dependency is not enough: an unlisted bundle is installed but never loaded.
 * @param profile - profile to read.
 * @returns true when `dsh.profile.bundles` names it.
 */
export async function automadBundled(profile: ProfileInfo): Promise<boolean> {
  try {
    const manifest: unknown = JSON.parse(await readFile(join(profile.dir, 'package.json'), 'utf8'))
    if (typeof manifest !== 'object' || manifest === null) return false
    const dsh = (manifest as { dsh?: unknown }).dsh
    if (typeof dsh !== 'object' || dsh === null) return false
    const profileBlock = (dsh as { profile?: unknown }).profile
    if (typeof profileBlock !== 'object' || profileBlock === null) return false
    const bundles = (profileBlock as { bundles?: unknown }).bundles
    return Array.isArray(bundles) && bundles.includes(AUTOMAD_PACKAGE)
  } catch {
    return false
  }
}

/**
 * Run the CLI's plugin-add for this profile.
 *
 * The install is long (clone, build, link) and chatty, so output is captured
 * rather than streamed: the panel polls the task and shows the tail on failure,
 * where pnpm's "add allowBuilds to pnpm-workspace.yaml" hint appears.
 * @param profile - profile to install into.
 * @param onLog - receives the accumulated tail, called once at the end.
 * @returns whether the CLI exited zero.
 */
export async function installAutomad(
  profile: ProfileInfo,
  onLog: (log: string) => void,
): Promise<{ ok: boolean; code: number | null; log: string }> {
  const cli = launcher()
  const argv = [...cli.args, 'plugin', '--profile', profile.name, 'add', AUTOMAD_SPEC]
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(cli.command, argv, {
      // The profile is passed explicitly, so the working directory only decides
      // how `--import tsx/esm` and the entry script are found: keep the host's.
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CI: '1', NO_COLOR: '1' },
    })
    let log = ''
    const collect = (chunk: Buffer): void => {
      log = `${log}${chunk.toString()}`.slice(-LOG_LIMIT)
    }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      log = `${log}\ninstall timed out after ${INSTALL_TIMEOUT_MS} ms`
    }, INSTALL_TIMEOUT_MS)
    child.on('error', error => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', code => {
      clearTimeout(timer)
      onLog(log)
      resolvePromise({ ok: code === 0, code, log })
    })
  })
}