/**
 * Session delete, browser half: a "Delete session" item in every Session menu and a trash button beside the archive
 * button on hover, a "Delete workspace and sessions" item in every Workspace menu, the confirmation dialog, and a
 * conversation watcher that leaves a Session once it is deleted.
 */
import { createElement, type ReactNode } from 'react'
import type { Capabilities } from '../shared.ts'
import type { ClientContext, SessionRowProps } from './dsh.ts'
import { de, en, es, fr, ja, pt, ru, zh } from './locales.ts'
import { sessionDeleteApi } from './rpc.ts'
import { createStore, type DeleteRequest } from './store.ts'
import { STYLES } from './styles.ts'
import { DeleteDialog, LeaveDeleted, RowButton, type Shared, type T } from './ui.tsx'

/** Services the contribution uses; `connection` carries the Host routes. */
export const inject = ['slots', 'locale', 'connection', 'contextMenus', 'uiWorkspace']

/** Dictionary namespace. */
const NS = 'sessionDelete'

/** The package name, which marks the injected style element. */
const PACKAGE = 'dsh-plugin-session-delete'

/**
 * Register the dictionaries, styles, menu items and slot entries.
 * @param ctx - client plugin context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { en, zh, ja, es, fr, de, ru, pt }), 'session-delete: locale')
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.plugin = PACKAGE
    style.textContent = STYLES
    document.head.appendChild(style)
    return () => { style.remove() }
  }, 'session-delete: styles')

  const api = sessionDeleteApi(ctx)
  const shared: Shared = {
    api,
    request: createStore<DeleteRequest | null>(null),
    deleted: createStore<ReadonlySet<string>>(new Set()),
    capabilities: createStore<Capabilities | null>(null),
    leave: () => { ctx.uiWorkspace.startSession() },
  }
  let live = true
  ctx.effect(() => () => { live = false; shared.request.set(null) }, 'session-delete: dialog state')
  api.capabilities().then((value) => { if (live) shared.capabilities.set(value) }, () => { /* the dialog then shows no restart hint */ })

  const t = ctx.locale.bind(NS) as T
  ctx.effect(() => ctx.contextMenus.register({
    id: 'sessionDelete.session', target: 'session', order: 650,
    observe: () => [ctx.locale],
    resolve: ({ sessionId, displayTitle }) => [{
      id: 'delete', label: t('menu.deleteSession'), icon: { key: 'workspace.delete' }, danger: true, afterContent: true,
      run: () => { shared.request.set({ kind: 'session', sessionId, title: displayTitle || t('untitled') }) },
    }],
  }), 'session-delete: session menu')
  ctx.effect(() => ctx.contextMenus.register({
    id: 'sessionDelete.workspace', target: 'workspace', order: 310,
    observe: () => [ctx.locale],
    resolve: ({ workspaceId, displayTitle }) => [{
      id: 'delete-with-sessions', label: t('menu.deleteWorkspace'), icon: { key: 'workspace.delete' }, danger: true,
      run: () => { shared.request.set({ kind: 'workspace', workspaceId, title: displayTitle }) },
    }],
  }), 'session-delete: workspace menu')

  ctx.slots.inject('sidebar.workspaces.session.row.action', () => ctx.slots.register(
    { name: 'sidebar.workspaces.session.row.action', id: 'session-delete', order: 110, locale: NS },
    (props: SessionRowProps & { t: T }): ReactNode => createElement(RowButton, { ...props, shared }),
  ))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register(
    { name: 'shell.overlay', id: 'session-delete.dialog', locale: NS },
    ({ t: bound }: { t: T }): ReactNode => createElement(DeleteDialog, { t: bound, shared }),
  ))
  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register(
    { name: 'conversation.session.header.utilities', id: 'session-delete.leave', order: 10_000 },
    ({ sessionId }: SessionRowProps): ReactNode => createElement(LeaveDeleted, { sessionId, shared }),
  ))
}
