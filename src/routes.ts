/**
 * Fetch routes shared by the Host plugin and the browser half.
 *
 * This module carries no imports on purpose. The browser bundle must not reach
 * a Host module: the browser module table holds only the platform singletons,
 * so anything the Host half pulls in — `@deepseek-ai/dsh-credentials`, the
 * `node:` builtins — fails the client entry at load.
 * @module dsh-thu-plugin/routes
 */

/** Exact Fetch routes, registered below `/api`. */
export const PANEL_PATH = '/api/thu/panel'
export const INSTALL_PATH = '/api/thu/install'
export const CREDENTIALS_PATH = '/api/thu/credentials'

/** Document-relative forms, so a subpath deployment still reaches the routes. */
export const PANEL_ROUTE = PANEL_PATH.slice(1)
export const INSTALL_ROUTE = INSTALL_PATH.slice(1)
export const CREDENTIALS_ROUTE = CREDENTIALS_PATH.slice(1)
