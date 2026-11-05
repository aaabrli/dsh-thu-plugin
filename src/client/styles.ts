/**
 * Class names and the one stylesheet this plugin injects.
 *
 * The bundle carries no CSS pipeline, so the stylesheet is a plain string
 * mounted as its own `<style>` element for the plugin's lifetime, keyed by a
 * data attribute so a hot reload cannot stack duplicates.
 *
 * It holds layout and this plugin's own surfaces only. Every interactive
 * control — button, text input — comes from
 * `@deepseek-ai/dsh-client-ui-primitives`, the same set the settings pages
 * shipped beside this one render from, because a feature package cannot import
 * another feature's component and hand-rolled controls drift in shape and
 * theme. Colors come from the shared `--dsw-*` tokens, which is what keeps
 * every surface correct in both themes.
 * @module dsh-thu-plugin/client/styles
 */

/** Owning plugin id, recorded on the injected `<style>` element. */
const PLUGIN_ID = 'dsh-thu-plugin'

/** Class names referenced from the components. */
export const css = {
  section: 'thSection',
  card: 'thCard',
  h2: 'thH2',
  h3: 'thH3',
  p: 'thP',
  note: 'thNote',
  log: 'thLog',
  error: 'thError',
  row: 'thRow',
  rowLabel: 'thRowLabel',
  rowValue: 'thRowValue',
  badge: 'thBadge',
  badgeOk: 'thBadgeOk',
  badgeIdle: 'thBadgeIdle',
  badgeWarn: 'thBadgeWarn',
  badgeError: 'thBadgeError',
  field: 'thField',
  fieldLabel: 'thFieldLabel',
  fieldState: 'thFieldState',
  actions: 'thActions',
} as const

const STYLESHEET = `
.thSection { display: flex; flex-direction: column; gap: 16px; padding: 4px 0 24px; }
.thCard {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  line-height: 19px;
}
.thH2 { margin: 0; font-size: 16px; font-weight: 600; }
.thH3 { margin: 0; font-size: 13px; font-weight: 600; }
.thP { margin: 0; color: var(--dsw-alias-label-secondary); }
.thNote { margin: 0; color: var(--dsw-alias-label-tertiary); }
.thLog {
  margin: 0;
  max-height: 180px;
  overflow: auto;
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-border-l2);
  color: var(--dsw-alias-label-secondary);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-all;
}
.thError { margin: 0; color: var(--dsw-alias-label-error); }

.thRow { display: flex; gap: 10px; align-items: baseline; }
.thRowLabel { flex: none; min-width: 160px; color: var(--dsw-alias-label-secondary); }
.thRowValue { min-width: 0; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }

.thBadge {
  display: inline-flex;
  align-items: center;
  padding: 0 8px;
  border-radius: 999px;
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 20px;
}
.thBadgeOk { color: var(--dsw-alias-state-success-label); }
.thBadgeIdle { color: var(--dsw-alias-label-tertiary); }
.thBadgeWarn { color: var(--dsw-alias-state-warn-label); }
.thBadgeError { color: var(--dsw-alias-label-error); }

.thField { display: flex; flex-direction: column; gap: 4px; }
.thFieldLabel { display: flex; align-items: center; gap: 8px; font-weight: 600; }
.thFieldState { font-weight: 400; color: var(--dsw-alias-label-tertiary); }
.thActions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
`

/**
 * Mount the stylesheet once. A second call is a no-op so hot reload cannot stack copies.
 * @returns a disposer that removes the element.
 */
export function installStyles(): () => void {
  const existing = document.querySelector(`style[data-plugin="${PLUGIN_ID}"]`)
  if (existing !== null) return () => { existing.remove() }
  const style = document.createElement('style')
  style.dataset.plugin = PLUGIN_ID
  style.textContent = STYLESHEET
  document.head.append(style)
  return () => { style.remove() }
}