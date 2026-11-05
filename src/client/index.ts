/**
 * Browser half of the Tsinghua tools panel.
 *
 * One settings page: it sits in the settings panel's own navigation, so the
 * composer keeps its space and the panel is reachable without a floating
 * control. The id is ours alone and collides with no core section.
 * @module dsh-thu-plugin/client
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the settings shell's SlotMap merge (the 'settings.section' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { ThuSection } from './Section.tsx'
import { NS, en, zh } from './locale.ts'
import { installStyles } from './styles.ts'

/** Cordis plugin name; the Host half uses the same string. */
export const name = 'thu'

/** Slot composition and the locale registry. */
export const inject = ['slots', 'locale']

/**
 * Register the dictionaries, the stylesheet, and the settings page.
 * @param ctx - browser plugin context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'thu: dictionaries')
  ctx.effect(() => installStyles(), 'thu: stylesheet')
  // One bound translate serves both the nav label thunk and the page body, so
  // a locale switch updates the label and the copy together.
  const t = ctx.locale.bind(NS)
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'thu',
    order: 40,
    label: () => t('nav.label'),
    locale: NS,
  }, ThuSection))
}