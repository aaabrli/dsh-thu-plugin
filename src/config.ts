/**
 * Load-time options for the Host plugin.
 *
 * This package ships outside the harness workspace and does not depend on the
 * harness schema package. `resolveOptions` throws from `apply` before any tool
 * registers, naming the offending field, which fails the plugin fiber at the
 * same moment a declared schema would.
 * @module dsh-thu-plugin/config
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

/** Validated options the Host half runs on. */
export interface ThuOptions {
  /** Workspace-relative directory downloads land in. */
  downloadDir: string
  /** Where paper PDFs go; empty means `<downloadDir>/papers` under the workspace. */
  paperDir: string
  /** Parallel file fetches for one cloud download. */
  concurrency: number
  /** Per-request timeout, in milliseconds. */
  timeoutMs: number
  /** Minimum gap between reserves CLI requests, in milliseconds. */
  reservesDelayMs: number
  /** Path to the reserves downloader CLI. Empty means not configured. */
  reservesCli: string
  /** Path to the reserves token file. Empty means not configured. */
  reservesTokenFile: string
  /** Wall clock a single reserves book may take, in milliseconds. */
  reservesTimeoutMs: number
  /** Credential reference holding the student id; default is the one `dsh-thu-automad` reads. */
  usernameRef: string
  /** Credential reference holding the unified-auth password; default is the one `dsh-thu-automad` reads. */
  passwordRef: string
  /** Path to the paper CLI. Empty means "look in the install location, then PATH". */
  paperCli: string
  /** Institution the paper CLI should use, filled in only when it has none; the gateway table is keyed by this name. */
  paperSchool: string
  /** English institution name for publisher login pages and the CARSI list. */
  paperSchoolEn: string
  /** Credential reference holding the email the open-access lookup requires. */
  paperEmailRef: string
  /** Wall clock a single paper fetch may take, in milliseconds. */
  paperTimeoutMs: number
}

/** Documented defaults, restated in cordis.patch.yml. */
const DEFAULTS = {
  downloadDir: 'thu-downloads',
  paperDir: '',
  concurrency: 2,
  timeoutMs: 90_000,
  reservesDelayMs: 1_500,
  reservesCli: '',
  reservesTokenFile: '',
  reservesTimeoutMs: 1_800_000,
  usernameRef: 'MADMODEL_USERNAME',
  passwordRef: 'MADMODEL_PASSWORD',
  paperCli: '',
  paperSchool: '清华大学',
  paperSchoolEn: 'Tsinghua University',
  paperEmailRef: 'THU_PAPER_EMAIL',
  paperTimeoutMs: 1_200_000,
} as const

/**
 * Where the settings page installs the reserves CLI when `reservesCli` is unset.
 * Keeping one default means the install button and the tool agree without the
 * user editing config first.
 * @returns absolute path of the installed binary.
 */
export function defaultReservesCli(): string {
  return join(homedir(), '.dsh', 'dsh-thu-plugin', 'reserves', 'downloader')
}

/**
 * Effective CLI path for one run: the configured path, else the install default.
 * @param options - validated plugin options.
 * @returns absolute path the tool will spawn.
 */
export function reservesCliPath(options: ThuOptions): string {
  return options.reservesCli.length > 0 ? options.reservesCli : defaultReservesCli()
}

/** Floor for the reserves request gap. The upstream author says faster requests get banned. */
const MIN_RESERVES_DELAY_MS = 1_000

/**
 * Validate one raw config value from cordis.yml.
 * @param config - raw `config` mapping of the loader row, absent when omitted.
 * @returns the options the Host half runs on.
 * @throws Error naming the offending field, before any tool registers.
 */
export function resolveOptions(config: unknown): ThuOptions {
  const record = asRecord(config)
  for (const key of Object.keys(record)) {
    if (!(key in DEFAULTS)) throw new Error(`dsh-thu-plugin: unknown config key "${key}"`)
  }
  const paperDir = text(record, 'paperDir', DEFAULTS.paperDir).trim()
  if (paperDir.includes('\u0000')) throw new Error('dsh-thu-plugin: paperDir cannot contain a NUL byte')
  const downloadDir = text(record, 'downloadDir', DEFAULTS.downloadDir)
  if (downloadDir.length === 0 || downloadDir.includes('..') || downloadDir.startsWith('/')) {
    throw new Error('dsh-thu-plugin: downloadDir must be a non-empty workspace-relative path')
  }
  return {
    downloadDir,
    paperDir,
    concurrency: count(record, 'concurrency', DEFAULTS.concurrency, 1, 4),
    timeoutMs: count(record, 'timeoutMs', DEFAULTS.timeoutMs, 1_000, 300_000),
    reservesDelayMs: count(record, 'reservesDelayMs', DEFAULTS.reservesDelayMs, MIN_RESERVES_DELAY_MS, 60_000),
    reservesCli: text(record, 'reservesCli', DEFAULTS.reservesCli),
    reservesTimeoutMs: count(record, 'reservesTimeoutMs', DEFAULTS.reservesTimeoutMs, 60_000, 7_200_000),
    reservesTokenFile: text(record, 'reservesTokenFile', DEFAULTS.reservesTokenFile),
    usernameRef: ref(record, 'usernameRef', DEFAULTS.usernameRef),
    passwordRef: ref(record, 'passwordRef', DEFAULTS.passwordRef),
    paperCli: text(record, 'paperCli', DEFAULTS.paperCli),
    paperSchool: text(record, 'paperSchool', DEFAULTS.paperSchool),
    paperSchoolEn: text(record, 'paperSchoolEn', DEFAULTS.paperSchoolEn),
    paperEmailRef: ref(record, 'paperEmailRef', DEFAULTS.paperEmailRef),
    paperTimeoutMs: count(record, 'paperTimeoutMs', DEFAULTS.paperTimeoutMs, 60_000, 3_600_000),
  }
}

/** Grammar the credentials seam itself accepts for a reference name. */
const REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u

/**
 * Read one credential-reference name.
 *
 * The pair defaults to the references `dsh-thu-automad` already reads
 * (`MADMODEL_USERNAME` / `MADMODEL_PASSWORD`), so the campus account entered once
 * feeds both plugins. Pinning another pair here keeps our half independent.
 */
function ref(record: Record<string, unknown>, key: string, fallback: string): string {
  const value = text(record, key, fallback)
  if (!REF_PATTERN.test(value)) {
    throw new Error(`dsh-thu-plugin: ${key} must look like an environment variable name`)
  }
  return value
}

/** Read a mapping, treating a missing config block as empty. */
function asRecord(config: unknown): Record<string, unknown> {
  if (config === undefined) return {}
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    throw new Error('dsh-thu-plugin: config must be a mapping')
  }
  return config as Record<string, unknown>
}

/** Read one string field. */
function text(record: Record<string, unknown>, key: string, fallback: string): string {
  const value = record[key]
  if (value === undefined) return fallback
  if (typeof value !== 'string') throw new Error(`dsh-thu-plugin: ${key} must be a string`)
  return value
}

/** Read one integer field inside an inclusive range. */
function count(record: Record<string, unknown>, key: string, fallback: number, min: number, max: number): number {
  const value = record[key]
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error(`dsh-thu-plugin: ${key} must be an integer`)
  }
  if (value < min || value > max) {
    throw new Error(`dsh-thu-plugin: ${key} must be between ${String(min)} and ${String(max)}`)
  }
  return value
}
