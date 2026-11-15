/** Type-only copies of the DSH browser interfaces the browser half uses. */
import type { ComponentType } from 'react'

/** A translate function bound to one locale namespace. */
export type Translate<K extends string = string> = (key: K, params?: Readonly<Record<string, string>>) => string

/** One RPC answer on the connection. */
export type RpcResult<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } }

/** Owner props of a Session row's hover button and the conversation header utilities. */
export interface SessionRowProps { readonly sessionId: string; readonly displayTitle?: string }

/** One context-menu action (`@deepseek-ai/dsh-client-ui-context-menu` `MenuAction`). */
export interface MenuAction {
  readonly id: string
  readonly label: string
  readonly icon?: { readonly key: string }
  readonly danger?: boolean
  readonly separatorBefore?: boolean
  readonly afterContent?: boolean
  readonly run?: () => void | Promise<void>
}

/** Targets this plugin contributes to. */
export interface MenuTargets {
  session: { readonly sessionId: string; readonly displayTitle: string }
  workspace: { readonly workspaceId: string; readonly displayTitle: string }
}

/** The browser Cordis context members the browser half uses. */
export interface ClientContext {
  readonly slots: {
    inject(name: string, register: () => () => void): void
    register<P>(options: { name: string; id?: string; key?: string; order?: number; locale?: string }, component: ComponentType<P>): () => void
  }
  readonly locale: {
    register(namespace: string, dictionaries: Readonly<Record<string, Readonly<Record<string, string>>>>): () => void
    bind(namespace: string): Translate
  }
  readonly contextMenus: {
    register<K extends keyof MenuTargets>(contribution: {
      readonly id: string
      readonly target: K
      readonly order: number
      observe?(target: MenuTargets[K]): readonly unknown[]
      resolve(target: MenuTargets[K]): readonly MenuAction[]
    }): () => void
  }
  readonly uiWorkspace: { startSession(): void }
  readonly connection: { readonly rpc: { call(channel: string, method: string, payload: unknown, signal?: AbortSignal): Promise<RpcResult<unknown>> } }
  effect(execute: () => () => void, label?: string): void
}
