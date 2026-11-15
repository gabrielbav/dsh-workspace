/** Browser state shared by the menu items, the row button, the dialog and the conversation watcher. */

/** The pending confirmation, or null when no dialog is open. */
export type DeleteRequest =
  | { readonly kind: 'session'; readonly sessionId: string; readonly title: string }
  | { readonly kind: 'workspace'; readonly workspaceId: string; readonly title: string }

/** A value with change subscription, read through `useSyncExternalStore`. */
export interface Store<T> {
  get(): T
  set(value: T): void
  subscribe(listener: () => void): () => void
}

/**
 * Create one store.
 * @param initial First value.
 * @returns The store.
 */
export function createStore<T>(initial: T): Store<T> {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    get: () => value,
    set: (next) => {
      if (Object.is(next, value)) return
      value = next
      for (const listener of [...listeners]) listener()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}
