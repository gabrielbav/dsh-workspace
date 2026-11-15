/** Connectors, browser half: the "Connectors" page in Settings with its navigation icon. */
import { createElement, type ReactNode } from 'react'
import type { ClientContext } from './dsh.ts'
import { en, pt } from './locales.ts'
import { connectorsApi } from './rpc.ts'
import { STYLES } from './styles.ts'
import { ConnectorsSection, NavIcon, type T } from './ui.tsx'

/** Services the contribution uses; `connection` carries the Host routes. */
export const inject = ['slots', 'locale', 'connection']

/** Dictionary namespace. */
const NS = 'connectors'

/** The package name, which marks the injected style element. */
const PACKAGE = 'dsh-connectors'

/** Settings section id; also addresses the navigation icon. */
const SECTION = 'connectors'

/**
 * Register the dictionaries, styles, the settings page and its icon.
 * @param ctx - client plugin context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { en, pt, zh: en, ja: en, es: en, fr: en, de: en, ru: en }), 'connectors: locale')
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.plugin = PACKAGE
    style.textContent = STYLES
    document.head.appendChild(style)
    return () => { style.remove() }
  }, 'connectors: styles')

  const api = connectorsApi(ctx)
  const t = ctx.locale.bind(NS) as T
  ctx.slots.inject('settings.section', () => ctx.slots.register(
    { name: 'settings.section', id: SECTION, order: 40, locale: NS, label: () => t('nav') },
    ({ t: bound }: { t: T }): ReactNode => createElement(ConnectorsSection, { t: bound, api }),
  ))
  ctx.slots.inject('settings.section.icon', () => ctx.slots.register(
    { name: 'settings.section.icon', id: SECTION },
    ({ size }: { size: number }): ReactNode => createElement(NavIcon, { size }),
  ))
}
