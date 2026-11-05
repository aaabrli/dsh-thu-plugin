/**
 * Two build faces for one dual-face plugin.
 *
 * The Host half is an ordinary ESM Node module. The browser half is a closure
 * factory: the Web client's module table owns execution, so the artifact
 * registers itself through `window.__ModuleLoader__.load` and resolves React
 * and harness packages through the `require` the table hands to the factory.
 *
 * `outExtensions` forces `lib/client.js` because the client scan reads the
 * exact path `package.json` exports, while `"type": "module"` would otherwise
 * emit the CommonJS artifact as `.cjs`.
 */
import { defineConfig } from 'tsdown'

/** Package name the browser module table keys this bundle by. */
const PLUGIN_ID = 'dsh-thu-plugin'

/** Specifiers the browser module table resolves for a plugin bundle. */
const BROWSER_EXTERNALS: readonly (string | RegExp)[] = [
  'react',
  'react-dom',
  'react/jsx-runtime',
  'react-dom/client',
  /^@deepseek-ai\//u,
]

export default defineConfig([
  {
    name: `${PLUGIN_ID}/host`,
    entry: ['src/index.ts'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    sourcemap: true,
    deps: { neverBundle: [/^@deepseek-ai\//u] },
  },
  {
    name: `${PLUGIN_ID}/client`,
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: ['cjs'],
    platform: 'browser',
    target: 'es2022',
    dts: false,
    clean: false,
    sourcemap: true,
    deps: { neverBundle: [...BROWSER_EXTERNALS] },
    outExtensions: () => ({ js: '.js' }),
    banner: {
      js: `window.__ModuleLoader__.load({
\tid: ${JSON.stringify(PLUGIN_ID)},
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
`,
    },
    footer: {
      js: `\t\treturn module.exports;
\t}
});
`,
    },
  },
])
