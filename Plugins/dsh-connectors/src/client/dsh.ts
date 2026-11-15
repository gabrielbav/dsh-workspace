/** Type-only copies of the DSH browser interfaces the browser half uses. */
import type { ComponentType } from 'react'

/** A translate function bound to one locale namespace. */
export type Translate<K extends string = string> = (key: K, params?: Readonly<Record<string, string>>) => string

/** One RPC answer on the connection. */
export type RpcResult<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } }

/** Options of one slot registration; `label` is the settings navigation text. */
export interface SlotOptions {
  readonly name: string
  readonly id?: string
  readonly order?: number
  readonly locale?: string
  readonly label?: string | (() => string)
}

/** The browser Cordis context members the browser half uses. */
export interface ClientContext {
  readonly slots: {
    inject(name: string, register: () => () => void): void
    register<P>(options: SlotOptions, component: ComponentType<P>): () => void
  }
  readonly locale: {
    register(namespace: string, dictionaries: Readonly<Record<string, Readonly<Record<string, string>>>>): () => void
    bind(namespace: string): Translate
  }
  readonly connection: { readonly rpc: { call(channel: string, method: string, payload: unknown, signal?: AbortSignal): Promise<RpcResult<unknown>> } }
  effect(execute: () => () => void, label?: string): void
}
