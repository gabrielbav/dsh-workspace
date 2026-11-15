/**
 * Connector registry and lifecycle. A connector is connected while its credential reference resolves: the service
 * then registers the connector's MCP server with the MCP manager, and the server reads the credential through a
 * `${credential:…}` template, so a renewed token reaches it without a re-registration. OAuth connectors keep the
 * refresh token and client id in a credential record and renew the access token ahead of its expiry.
 */
import type { ConnectorState, ConnectorView, OAuthStart } from '../shared.ts'
import type { ConnectorDefinition, ConnectorsService } from './api.ts'
import type { Credentials, Logger, McpManager, McpServerStatus } from './dsh.ts'
import { parseGrant, refresh, startSignIn, type IssuedTokens, type OAuthGrant, type OAuthProtocol } from './oauth.ts'

/** Credential record scope: this plugin. */
const RECORD_SCOPE = 'dsh-connectors'

/** Connector ids: MCP server names and credential key segments at once. */
const ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/

/** Ids whose credential record key this plugin uses for its own state. */
const RESERVED_IDS: ReadonlySet<string> = new Set(['custom-connectors'])

/** Timing choices. */
export interface ConnectorTimings {
  /** How long an OAuth callback waits for the browser. */
  readonly signInTimeoutMs: number
  /** How long before expiry an access token is renewed. */
  readonly refreshLeewayMs: number
  /** Delay before retrying a renewal that failed for a reason other than a revoked grant. */
  readonly refreshRetryMs: number
}

/** Defaults for {@link ConnectorTimings}. */
export const DEFAULT_TIMINGS: ConnectorTimings = { signInTimeoutMs: 10 * 60_000, refreshLeewayMs: 5 * 60_000, refreshRetryMs: 60_000 }

/** What the connectors need from the Host. */
export interface ConnectorDeps {
  readonly mcp: McpManager
  readonly credentials: Credentials
  readonly logger: Logger
  readonly fetch: typeof fetch
  readonly timings: ConnectorTimings
  readonly protocol?: OAuthProtocol
  readonly now?: () => number
}

/** The credential record payload. */
interface Stored {
  readonly via: 'oauth' | 'token'
  readonly account?: string
  readonly values?: Readonly<Record<string, string>>
  readonly grant?: OAuthGrant
}

/** Mutable runtime of one registered connector. */
interface Runtime {
  readonly def: ConnectorDefinition
  readonly ref: string
  readonly key: string
  unregister: (() => void) | undefined
  signIn: AbortController | undefined
  refreshTimer: ReturnType<typeof setTimeout> | undefined
  /** A failure the MCP status cannot show: a refused sign-in, a failed renewal, a refused registration. */
  error: string | undefined
  stored: Stored | undefined
  removed: boolean
}

const message = (error: unknown): string => error instanceof Error ? error.message : String(error)

/**
 * The credential reference of a connector.
 * @param id Connector id.
 * @returns `DSH_CONNECTORS_<ID>_TOKEN`; never a generic name, because the local store falls back to the environment.
 */
export function tokenRef(id: string): string {
  return `DSH_CONNECTORS_${id.toUpperCase().replaceAll('-', '_')}_TOKEN`
}

/**
 * Read a stored record payload, including the 0.1 formats (a bare grant, or `{ account }` for a token).
 * @param payload Stored payload.
 * @returns The record, or undefined when it is not one this plugin wrote.
 */
export function parseStored(payload: unknown): Stored | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const value = payload as Record<string, unknown>
  const account = typeof value.account === 'string' ? { account: value.account } : {}
  if (value.via === 'oauth' || value.via === 'token') {
    const grant = value.grant === undefined ? undefined : parseGrant(value.grant)
    const values = typeof value.values === 'object' && value.values !== null
      ? Object.fromEntries(Object.entries(value.values).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
      : undefined
    return { via: value.via, ...account, ...values === undefined ? {} : { values }, ...grant === undefined ? {} : { grant } }
  }
  const legacy = parseGrant(payload)
  return legacy !== undefined ? { via: 'oauth', grant: legacy } : { via: 'token', ...account }
}

/**
 * Drop the MCP client's diagnostic prefixes (`mcp-client(github): startup: SdkHttpError: `) from a server error.
 * @param text Diagnostic text.
 * @returns The message a person reads.
 */
export function cleanError(text: string): string {
  return text.trim().replace(/^mcp-client\([^)]*\):\s*[\w -]+:\s*/, '').replace(/^(?:Sdk)?\w*Error:\s*/, '')
}

/**
 * Translate the MCP manager's status into a table state.
 * @param status Server status, or undefined when the server is not registered.
 * @returns The state.
 */
export function stateOf(status: McpServerStatus | undefined): ConnectorState {
  if (status === undefined) return { kind: 'disconnected' }
  switch (status.state) {
    case 'connected': return { kind: 'connected', toolCount: status.toolCount }
    case 'connecting': return { kind: 'connecting' }
    case 'reconnecting': return { kind: 'connecting', detail: cleanError(status.lastError) }
    case 'waiting-credentials': return { kind: 'error', message: 'The stored token is missing. Connect again.' }
    case 'failed': return { kind: 'error', message: status.lastError === undefined ? `The connection stopped (${status.reason}).` : cleanError(status.lastError) }
    case 'closed':
    case 'disabled': return { kind: 'disconnected' }
    default: return { kind: 'error', message: 'Unknown server status.' }
  }
}

/**
 * Create the registry.
 * @param deps Host services.
 * @returns The public service plus the operations the Settings routes call and `dispose`.
 */
export function connectors(deps: ConnectorDeps) {
  const now = deps.now ?? Date.now
  const runtimes = new Map<string, Runtime>()
  let disposed = false

  const runtime = (id: string): Runtime => {
    const found = runtimes.get(id)
    if (found === undefined) throw new RangeError(`unknown connector ${id}`)
    return found
  }
  const live = (rt: Runtime): boolean => !disposed && !rt.removed

  const register = (rt: Runtime): void => {
    if (rt.unregister !== undefined || !live(rt)) return
    try {
      const server = rt.def.server({ credential: `\${credential:${rt.ref}}`, values: rt.stored?.values ?? {} })
      rt.unregister = deps.mcp.register(rt.def.id, server)
      rt.error = undefined
    } catch (error) {
      rt.error = `The MCP server could not be added: ${message(error)}`
    }
  }
  const unregister = (rt: Runtime): void => {
    rt.unregister?.()
    rt.unregister = undefined
  }
  const stopRefresh = (rt: Runtime): void => {
    if (rt.refreshTimer !== undefined) clearTimeout(rt.refreshTimer)
    rt.refreshTimer = undefined
  }
  const store = async (rt: Runtime, stored: Stored, credential: string): Promise<void> => {
    await deps.credentials.modifyRecord(rt.key, () => Promise.resolve({ kind: 'grant', payload: stored }))
    await deps.credentials.set(rt.ref, credential)
    rt.stored = stored
  }

  const identify = async (rt: Runtime, accessToken: string): Promise<string | undefined> => {
    const read = rt.def.oauth?.identify
    if (read === undefined) return rt.stored?.account
    try { return await read(accessToken, deps.fetch) }
    catch (error) {
      deps.logger.warn(`dsh-connectors: reading the ${rt.def.id} account failed`, error)
      return rt.stored?.account
    }
  }

  const storeTokens = async (rt: Runtime, issued: IssuedTokens): Promise<void> => {
    const account = await identify(rt, issued.accessToken)
    await store(rt, { via: 'oauth', grant: issued.grant, ...account === undefined ? {} : { account } }, issued.accessToken)
    schedule(rt, issued.grant)
  }

  /** Renew the access token ahead of expiry; a grant without a lifetime is never renewed. */
  const schedule = (rt: Runtime, grant: OAuthGrant): void => {
    stopRefresh(rt)
    if (grant.expiresAt === undefined || !live(rt)) return
    const delay = Math.max(0, grant.expiresAt - deps.timings.refreshLeewayMs - now())
    rt.refreshTimer = setTimeout(() => { void renew(rt) }, delay)
    rt.refreshTimer.unref?.()
  }

  const renew = async (rt: Runtime): Promise<boolean> => {
    rt.refreshTimer = undefined
    try {
      const grant = rt.stored?.grant
      if (grant === undefined) return false
      const issued = await refresh(grant, deps.protocol, now, rt.def.oauth?.client)
      // A Disconnect or a new sign-in during the renewal replaced the grant; this result is stale.
      if (!live(rt) || rt.stored?.grant !== grant) return false
      await storeTokens(rt, issued)
      rt.error = undefined
      // A renewal that succeeds on a retry after a failed start registers the server here; a changed token value
      // makes a registered server reconnect on its own, even after it gave up.
      register(rt)
      return true
    } catch (error) {
      if (!live(rt)) return false
      const revoked = /invalid_grant|cannot be renewed/i.test(message(error))
      rt.error = revoked ? 'The sign-in expired. Connect again.' : `Renewing the sign-in failed: ${message(error)}`
      deps.logger.warn(`dsh-connectors: renewing ${rt.def.id} failed`, error)
      if (!revoked) {
        rt.refreshTimer = setTimeout(() => { void renew(rt) }, deps.timings.refreshRetryMs)
        rt.refreshTimer.unref?.()
      }
      return false
    }
  }

  /** Load a connector's stored credential and register its server, renewing an expired OAuth token first. */
  const start = async (rt: Runtime): Promise<void> => {
    try {
      const record = await deps.credentials.readRecord(rt.key)
      if (!live(rt)) return
      rt.stored = record?.kind === 'grant' ? parseStored(record.payload) : undefined
      const grant = rt.stored?.grant
      if (rt.stored?.via === 'oauth' && grant !== undefined) {
        if (grant.expiresAt !== undefined && grant.expiresAt - deps.timings.refreshLeewayMs <= now()) {
          await renew(rt)
          return
        }
        schedule(rt, grant)
      } else if (!(await deps.credentials.describe(rt.ref)).configured) {
        return
      }
      register(rt)
    } catch (error) {
      rt.error = `Loading the stored credential failed: ${message(error)}`
      deps.logger.warn(`dsh-connectors: starting ${rt.def.id} failed`, error)
    }
  }

  const view = (rt: Runtime, statuses: ReadonlyMap<string, McpServerStatus>): ConnectorView => {
    const { def } = rt
    let state: ConnectorState
    if (rt.signIn !== undefined) state = { kind: 'authorizing' }
    else if (rt.error !== undefined) state = { kind: 'error', message: rt.error }
    else state = rt.unregister === undefined ? { kind: 'disconnected' } : stateOf(statuses.get(def.id))
    const auth = [...def.oauth === undefined ? [] : ['oauth' as const], ...def.token === undefined ? [] : ['token' as const]]
    const connected = rt.unregister !== undefined
    return {
      id: def.id, name: def.name, description: def.description, type: 'mcp', auth,
      ...def.icon === undefined ? {} : { icon: def.icon },
      ...def.token === undefined ? {} : {
        fields: def.token.fields.map(field => ({
          id: field.id, label: field.label, secret: field.secret === true,
          ...field.placeholder === undefined ? {} : { placeholder: field.placeholder },
        })),
      },
      ...def.token?.helpUrl === undefined ? {} : { tokenUrl: def.token.helpUrl },
      ...def.oauth?.setupUrl === undefined ? {} : { setupUrl: def.oauth.setupUrl },
      ...def.setup === undefined || auth.length > 0 ? {} : { setup: { reason: def.setup.reason, ...def.setup.helpUrl === undefined ? {} : { helpUrl: def.setup.helpUrl } } },
      ...!connected || rt.stored?.account === undefined ? {} : { account: rt.stored.account },
      ...!connected || rt.stored === undefined ? {} : { via: rt.stored.via },
      registered: connected,
      state,
    }
  }

  const list = (): ConnectorView[] => {
    const statuses = new Map(deps.mcp.list().map(server => [server.name, server.status]))
    return [...runtimes.values()].map(rt => view(rt, statuses))
  }

  const service: ConnectorsService = {
    register(def: ConnectorDefinition): () => void {
      if (disposed) throw new Error('dsh-connectors: the connectors service is disposed')
      if (!ID_PATTERN.test(def.id)) throw new Error(`connector id "${def.id}" must match ${String(ID_PATTERN)}`)
      if (RESERVED_IDS.has(def.id)) throw new Error(`connector id "${def.id}" is reserved`)
      if (runtimes.has(def.id)) throw new Error(`connector "${def.id}" is already registered`)
      if (def.oauth === undefined && def.token === undefined && def.setup === undefined) throw new Error(`connector "${def.id}" offers neither oauth nor token, and no setup`)
      const rt: Runtime = {
        def, ref: tokenRef(def.id), key: `${RECORD_SCOPE}/${def.id}`,
        unregister: undefined, signIn: undefined, refreshTimer: undefined, error: undefined, stored: undefined, removed: false,
      }
      runtimes.set(def.id, rt)
      void start(rt)
      return () => {
        if (rt.removed) return
        rt.removed = true
        rt.signIn?.abort()
        stopRefresh(rt)
        unregister(rt)
        if (runtimes.get(def.id) === rt) runtimes.delete(def.id)
      }
    },
    list,
  }

  return {
    service,
    list,

    /**
     * Start an OAuth sign-in; the connector registers once the browser returns.
     * @param id Connector id.
     * @returns The page the browser opens.
     */
    async beginOAuth(id: string): Promise<OAuthStart> {
      const rt = runtime(id)
      const oauth = rt.def.oauth
      if (oauth === undefined) throw new RangeError(`${rt.def.name} does not sign in with OAuth`)
      rt.signIn?.abort()
      const controller = new AbortController()
      rt.signIn = controller
      rt.error = undefined
      try {
        const pending = await startSignIn({
          serverUrl: oauth.resourceUrl, clientName: 'DeepSeek Harness', timeoutMs: deps.timings.signInTimeoutMs, signal: controller.signal,
          ...oauth.client === undefined ? {} : { client: oauth.client },
          ...oauth.scopes === undefined ? {} : { scopes: oauth.scopes },
          ...oauth.callbackPort === undefined ? {} : { callbackPort: oauth.callbackPort },
          ...oauth.authorizationParams === undefined ? {} : { authorizationParams: oauth.authorizationParams },
          ...deps.protocol === undefined ? {} : { protocol: deps.protocol }, now,
        })
        pending.done.then(async (issued) => {
          if (controller.signal.aborted || !live(rt)) return
          await storeTokens(rt, issued)
          unregister(rt)
          register(rt)
        }).catch((error: unknown) => {
          if (rt.signIn === controller && !controller.signal.aborted) rt.error = message(error)
          deps.logger.warn(`dsh-connectors: signing in to ${rt.def.id} failed`, error)
        }).finally(() => {
          if (rt.signIn === controller) rt.signIn = undefined
        })
        return { url: pending.url }
      } catch (error) {
        if (rt.signIn === controller) rt.signIn = undefined
        throw error
      }
    },

    /**
     * Withdraw a running OAuth sign-in.
     * @param id Connector id.
     */
    cancelOAuth(id: string): void {
      const rt = runtime(id)
      rt.signIn?.abort()
      rt.signIn = undefined
    },

    /**
     * Verify and store the token form of a connector, then register its server.
     * @param id Connector id.
     * @param values Form values keyed by field id.
     */
    async setToken(id: string, values: Readonly<Record<string, string>>): Promise<void> {
      const rt = runtime(id)
      const method = rt.def.token
      if (method === undefined) throw new RangeError(`${rt.def.name} does not take a token`)
      const trimmed: Record<string, string> = {}
      for (const field of method.fields) {
        const value = values[field.id]?.trim() ?? ''
        if (value === '') throw new RangeError(`${field.label} is empty`)
        trimmed[field.id] = value
      }
      const verified = await method.verify(trimmed, deps.fetch)
      if (verified.credential === '') throw new Error('the connector produced an empty credential')
      stopRefresh(rt)
      await store(rt, {
        via: 'token',
        ...verified.account === undefined ? {} : { account: verified.account },
        ...verified.values === undefined ? {} : { values: verified.values },
      }, verified.credential)
      rt.error = undefined
      // The server entry may depend on the form values, so it is rebuilt rather than restarted.
      unregister(rt)
      register(rt)
    },

    /**
     * Rebuild a connected server's connection, for example after it gave up reconnecting.
     * @param id Connector id.
     */
    async reconnect(id: string): Promise<void> {
      const rt = runtime(id)
      if (rt.unregister === undefined) throw new RangeError(`${rt.def.name} is not connected`)
      rt.error = undefined
      await deps.mcp.restart(rt.def.id)
    },

    /**
     * Remove the server and forget every stored credential of a connector.
     * @param id Connector id.
     */
    async disconnect(id: string): Promise<void> {
      const rt = runtime(id)
      rt.signIn?.abort()
      rt.signIn = undefined
      stopRefresh(rt)
      unregister(rt)
      await deps.credentials.unset(rt.ref)
      await deps.credentials.deleteRecord(rt.key)
      rt.stored = undefined
      rt.error = undefined
    },

    /** Stop timers and sign-ins and remove every server; stored credentials stay. */
    dispose(): void {
      disposed = true
      for (const rt of runtimes.values()) {
        rt.signIn?.abort()
        stopRefresh(rt)
        unregister(rt)
      }
      runtimes.clear()
    },
  }
}

/** The operations {@link connectors} returns. */
export type Connectors = ReturnType<typeof connectors>
