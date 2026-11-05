/**
 * Local check for the browser half.
 *
 *   pnpm run check:client        (from this package)
 *
 * The Web boot page reports "Failed to load plugins" when a client entry
 * throws, and the browser module table resolves only the platform singletons
 * plus the client entries it already loaded. A `require` of any other
 * specifier — most easily a Host module pulled in through a shared import —
 * fails the entry at load, in the browser only. This check reads the built
 * bundle and rejects every specifier outside that resolvable set, so the
 * failure surfaces here instead of on the boot page.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

/**
 * Platform singletons the shell seeds into the module table before any plugin
 * bundle runs. Mirrors `PLATFORM_MODULES` in
 * `packages/client/web/src/platform.ts`.
 */
const PLATFORM_SINGLETONS = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  'zod',
  '@tanstack/react-virtual',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
])

const manifest: {
  name: string
  dsh?: { client?: { inject?: string[] } }
} = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))

/** Packages this bundle declared it needs loaded before itself. */
const declaredInject = new Set(manifest.dsh?.client?.inject ?? [])

const bundle = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')

// Only `require("<literal>")` counts: a computed specifier cannot be checked
// here and the bundle is generated, so a non-literal one is a build mistake.
const required = [...bundle.matchAll(/\brequire\((["'])([^"']+)\1\)/gu)].map(match => match[2] as string)

assert.ok(required.length > 0, 'client bundle requires nothing; the externals were bundled in')

const unresolved = required.filter(
  specifier => !PLATFORM_SINGLETONS.has(specifier) && !declaredInject.has(specifier),
)
assert.deepEqual(
  unresolved,
  [],
  `client bundle requires specifiers the browser module table cannot resolve: ${unresolved.join(', ')}`,
)

assert.match(
  bundle,
  new RegExp(`id:\\s*${JSON.stringify(manifest.name)}`, 'u'),
  'client bundle registers under a different id than the package name',
)

// The boot loader reads `apply`/`inject`/`name` off the registered export.
for (const exportName of ['apply', 'inject', 'name']) {
  assert.match(bundle, new RegExp(`exports\\.${exportName}\\b`, 'u'), `client bundle does not export ${exportName}`)
}

// The seat moved from the shell overlay to the settings panel's navigation.
assert.match(
  bundle,
  /["']settings\.section["']/u,
  'client bundle does not register into settings.section',
)
assert.doesNotMatch(bundle, /["']shell\.overlay["']/u, 'client bundle still occupies shell.overlay')

console.log('client-bundle: ok')
