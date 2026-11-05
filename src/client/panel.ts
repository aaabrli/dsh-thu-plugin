/**
 * Browser client for the panel routes.
 *
 * Relative paths keep the routes reachable when the GUI is mounted below a
 * subpath. Responses never contain secret values; this module does not store
 * any either.
 * @module dsh-thu-plugin/client/panel
 */

import { CREDENTIALS_ROUTE, INSTALL_ROUTE, PANEL_ROUTE } from '../routes.ts'

/** One credential field as the settings page shows it. */
export interface FieldView {
  id: string
  configured: boolean
  writable: boolean
  secret: boolean
  /**
   * Set for the fingerprint field: whether the record shared with
   * `dsh-thu-automad` also holds one, which is what makes `configured` true
   * without this plugin's own reference being written.
   */
  shared?: boolean
}

/** One row in the status card: an external tool this page can install. */
export type ToolView =
  | { id: 'reserves'; installed: boolean; path: string }
  | {
    id: 'papers'
    installed: boolean
    /** Absolute path of the CLI the tools would spawn; null when none is on this machine. */
    path: string | null
  }
  | {
    id: 'automad'
    /** Profile the button installs into; empty when the host could not tell. */
    profile: string
    /** The git spec the button installs. */
    spec: string
    /** Recorded dependency spec; empty when the profile does not list it. */
    installed: string
    /** Whether the bundle list names it too — false means installed but not loaded. */
    bundled: boolean
  }

/** Section snapshot. */
export interface PanelView {
  tools: ToolView[]
  fields: FieldView[]
}

/** Install task the section polls. */
export interface InstallView {
  taskId?: string
  state: 'running' | 'done' | 'failed' | 'unknown'
  error?: string
  reason?: string
  /** Latest progress line while the install runs. */
  progress?: string
  /** Tail of the installer output, shown when it fails or prints a hint. */
  log?: string
  /** A finished install still needs a host restart before the plugin loads. */
  restartRequired?: boolean
}

/**
 * Load the section snapshot.
 * @returns the snapshot, or null when the route is unreachable.
 */
export async function loadPanel(): Promise<PanelView | null> {
  const response = await fetch(PANEL_ROUTE, { cache: 'no-store' })
  if (!response.ok) return null
  return response.json() as Promise<PanelView>
}

/**
 * Start installing the reserves CLI.
 * @returns the task view. A 400 still carries a reason.
 */
export async function startReservesInstall(): Promise<InstallView> {
  const response = await fetch(INSTALL_ROUTE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tool: 'reserves' }),
  })
  return response.json() as Promise<InstallView>
}

/**
 * Start installing `dsh-thu-automad` into the running profile.
 *
 * Git-hosted plugins build through their `prepare` script, which pnpm blocks
 * until the profile allows it, so a failure here is normal and its log says
 * exactly which key to add.
 * @returns the task view. A 400 still carries a reason.
 */
export async function startAutomadInstall(): Promise<InstallView> {
  const response = await fetch(INSTALL_ROUTE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tool: 'automad' }),
  })
  return response.json() as Promise<InstallView>
}

/**
 * Start installing the paper CLI (`instsci`) with uv or pipx.
 * @returns the task view. A 400 carries `no-installer` when neither is present.
 */
export async function startPapersInstall(): Promise<InstallView> {
  const response = await fetch(INSTALL_ROUTE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tool: 'papers' }),
  })
  return response.json() as Promise<InstallView>
}

/**
 * Poll one install task.
 * @param taskId - id from {@link startReservesInstall}.
 * @returns the task view.
 */
export async function pollInstall(taskId: string): Promise<InstallView> {
  const response = await fetch(`${INSTALL_ROUTE}?taskId=${encodeURIComponent(taskId)}`, { cache: 'no-store' })
  return response.json() as Promise<InstallView>
}

/**
 * Save or clear one credential. An empty value clears it.
 * @param id - field id.
 * @param value - new value, or empty to unset.
 * @returns whether the write was accepted.
 */
export async function saveCredential(id: string, value: string): Promise<boolean> {
  const response = await fetch(CREDENTIALS_ROUTE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, value }),
  })
  if (!response.ok) return false
  const body = await response.json() as { ok?: boolean }
  return body.ok === true
}
