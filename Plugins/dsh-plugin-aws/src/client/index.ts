/** AWS, browser half: the "AWS" page in Settings with its navigation icon. */
import { createElement, type ReactNode } from 'react'
import type { ClientContext } from './dsh.ts'
import { en, pt } from './locales.ts'
import { awsApi } from './rpc.ts'
import { STYLES } from './styles.ts'
import { AwsSection, NavIcon, type T } from './ui.tsx'

/** Services the contribution uses; `connection` carries the Host routes. */
export const inject = ['slots', 'locale', 'connection']

/** Dictionary namespace. */
const NS = 'awsMcp'

/** The package name, which marks the injected style element. */
const PACKAGE = 'dsh-plugin-aws'

/** Settings section id; also addresses the navigation icon. */
const SECTION = 'aws'

/**
 * Register the dictionaries, styles, the settings page and its icon.
 * @param ctx - client plugin context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { en, pt, zh: en, ja: en, es: en, fr: en, de: en, ru: en }), 'aws: locale')
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.plugin = PACKAGE
    style.textContent = STYLES
    document.head.appendChild(style)
    return () => { style.remove() }
  }, 'aws: styles')

  const api = awsApi(ctx)
  const t = ctx.locale.bind(NS) as T
  ctx.slots.inject('settings.section', () => ctx.slots.register(
    { name: 'settings.section', id: SECTION, order: 41, locale: NS, label: () => t('nav') },
    ({ t: bound }: { t: T }): ReactNode => createElement(AwsSection, { t: bound, api }),
  ))
  ctx.slots.inject('settings.section.icon', () => ctx.slots.register(
    { name: 'settings.section.icon', id: SECTION },
    ({ size }: { size: number }): ReactNode => createElement(NavIcon, { size }),
  ))
}
