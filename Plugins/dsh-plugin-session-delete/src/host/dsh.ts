/**
 * Type-only copies of the DeepSeek Harness Host interfaces this plugin uses. Nothing here exists at runtime, so the
 * package loads against any DSH release that provides these members; the optional `releaseAgent` is detected at
 * call time.
 */

/** Header fields of one stored Session (`@deepseek-ai/dsh-session` `SessionHeader`). */
export interface SessionHeader {
  readonly id: string
  readonly cwd?: string
  readonly parentSession?: string
  readonly origin?: 'subagent'
}

/** One stored Session (`SessionPersistenceSnapshot`). */
export interface PersistenceSnapshot {
  readonly header: SessionHeader
  /** The selected generation file; absent for a Session with nothing on disk yet. */
  readonly location?: { readonly kind: string; readonly path: string }
}

/** An open Session log (`SessionHandle`); this plugin only opens and closes it. */
export interface SessionHandle {
  close(): Promise<void>
}

/** `ctx.sessionPersistence`; `config.root` exists on the JSONL backend. */
export interface SessionPersistence {
  list(): Promise<readonly PersistenceSnapshot[]>
  stat(id: string): Promise<PersistenceSnapshot | undefined>
  open(id: string, access: 'read' | 'write'): Promise<SessionHandle>
  readonly config?: { readonly root?: unknown }
}

/** One Workspace entity (`@deepseek-ai/dsh-workspace` `Workspace`). */
export interface Workspace {
  readonly id: string
  readonly sessionIds: readonly string[]
  detachSession(sessionId: string): Promise<void>
}

/** `ctx.workspaceRegistry`. */
export interface WorkspaceRegistry {
  get(id: string): Workspace | undefined
  list(): readonly Workspace[]
  delete(id: string): Promise<boolean>
  readonly pinnedSessionIds: readonly string[]
  unpinSession(sessionId: string): Promise<void>
}

/** One activity family the `workspace/session-activity` providers report. */
export interface SessionActivity {
  readonly kind: string
  readonly items?: readonly { readonly id: string; readonly label?: string }[]
}

/** `SessionController.releaseAgent` result (DSH with the release method). */
export type ReleaseResult =
  | { readonly released: true }
  | { readonly released: false; readonly reason: 'not-loaded' | 'not-owned' }
  | { readonly released: false; readonly reason: 'active'; readonly activity: readonly SessionActivity[] }

/** `ctx.sessionController`, as far as this plugin uses it. */
export interface SessionController {
  readonly releaseAgent?: (sessionId: string) => Promise<ReleaseResult>
}

/** One exact Fetch route on the Host connection; non-owner Peers receive 403. */
export interface FetchRoute {
  readonly path: string
  readonly methods: readonly string[]
  readonly requestBody: 'buffered'
  readonly fetch: (request: Request) => Promise<Response>
}

/** The Cordis context members the Host half uses. */
export interface HostContext {
  readonly sessionPersistence: SessionPersistence
  readonly workspaceRegistry: WorkspaceRegistry
  readonly sessions: { get(id: string): { readonly header: SessionHeader } | undefined }
  readonly agents: { get(id: string): object | undefined }
  readonly logger: { warn(...args: unknown[]): void; info(...args: unknown[]): void }
  get(name: 'sessionController'): SessionController | undefined
  emit(name: 'api-session/removed', sessionId: string): void
  waterfall(
    name: 'workspace/session-activity',
    request: { readonly sessionId: string },
    next: () => Promise<readonly SessionActivity[]>,
  ): Promise<readonly SessionActivity[]>
  effect(execute: () => () => void | Promise<void>, label?: string): void
  inject(names: readonly string[], callback: (ctx: HostContext & { readonly connection: { fetch: { register(route: FetchRoute): () => void } } }) => void): void
}
