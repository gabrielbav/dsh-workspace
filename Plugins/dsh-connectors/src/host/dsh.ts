/**
 * Type-only copies of the DeepSeek Harness Host interfaces this plugin uses. Nothing here exists at runtime, so the
 * package loads against any DSH release that provides these members.
 */

/** `@deepseek-ai/dsh-mcp-client` connection status, as far as this plugin reads it. */
export type McpServerStatus =
  | { readonly state: 'closed' }
  | { readonly state: 'disabled' }
  | { readonly state: 'waiting-credentials'; readonly lastError: string }
  | { readonly state: 'connecting'; readonly attempt: number }
  | { readonly state: 'connected'; readonly toolCount: number }
  | { readonly state: 'reconnecting'; readonly attempt: number; readonly maxAttempts: number; readonly lastError: string }
  | { readonly state: 'failed'; readonly reason: string; readonly lastError?: string }

/** One managed server (`McpManagedServerView`). */
export interface McpServerView {
  readonly name: string
  readonly configured: boolean
  readonly status: McpServerStatus
}

/** A plugin-registered server entry (`McpServerRegistration`); header and env values may use `${credential:REF}`. */
export type McpServerRegistration = import('./api.ts').ConnectorServer

/** `ctx.mcpManager`. */
export interface McpManager {
  /** @returns a disposer that removes the registration. */
  register(name: string, entry: McpServerRegistration): () => void
  list(): McpServerView[]
  restart(name: string): Promise<void>
}

/** A stored credential record (`@deepseek-ai/dsh-credentials` `CredentialRecord`); this plugin writes grants only. */
export type CredentialRecord =
  | { readonly kind: 'grant'; readonly payload: unknown }
  | { readonly kind: 'api-key'; readonly [field: string]: unknown }

/** `ctx.credentials`. References are environment-variable-shaped names; record keys are `<scope>/<id>`. */
export interface Credentials {
  describe(ref: string): Promise<{ readonly configured: boolean; readonly source?: string; readonly writable: boolean }>
  set(ref: string, value: string): Promise<void>
  unset(ref: string): Promise<void>
  readRecord(key: string): Promise<CredentialRecord | undefined>
  modifyRecord(key: string, mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>): Promise<unknown>
  deleteRecord(key: string): Promise<void>
}

/** One exact Fetch route on the Host connection; non-owner Peers receive 403. */
export interface FetchRoute {
  readonly path: string
  readonly methods: readonly string[]
  readonly requestBody: 'buffered'
  readonly fetch: (request: Request) => Promise<Response>
}

/** Logger members the Host half uses. */
export interface Logger {
  warn(...args: unknown[]): void
  info(...args: unknown[]): void
}

/** The Cordis context members the Host half uses. */
export interface HostContext {
  readonly mcpManager: McpManager
  readonly credentials: Credentials
  readonly logger: Logger
  effect(execute: () => () => void | Promise<void>, label?: string): void
  /** Register a service owned by this plugin's fiber. */
  provide(name: 'connectors', value: import('./api.ts').ConnectorsService): () => void
  get(name: 'pluginManager'): import('./packages.ts').PluginManager | undefined
  inject(names: readonly string[], callback: (ctx: HostContext & { readonly connection: { fetch: { register(route: FetchRoute): () => void } } }) => void): void
}
