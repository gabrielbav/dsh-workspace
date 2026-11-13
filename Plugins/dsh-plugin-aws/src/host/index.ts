/**
 * AWS, Host half. Keeps every enabled AWS MCP server registered with the harness MCP manager, so all sessions get
 * its tools as `mcp__<id>__<tool>`, and answers the AWS settings page over exact `/api/awsMcp.<endpoint>` routes,
 * which the connection answers only for the owner. Secret form values go to the credential store and are never
 * sent back to the page.
 */
import type { FieldView, Overview, ServerInfo, ServerState, ServerView } from '../shared.ts'
import { GROUPS, PROXY_PACKAGE, PROXY_VERSION, SERVER_BY_ID, SERVERS, type CatalogServer } from './catalog.ts'
import type { FetchRoute, HostContext, McpServerRegistration, McpServerStatus } from './dsh.ts'
import { awsProfiles, PROFILE, REGION, uvLocator } from './environment.ts'
import { EMPTY_SERVER, missingSettings, parseExtraEnv, registration, secretRef, type ServerSettings } from './launch.ts'
import { readSettings, writeSettings, type StoredSettings } from './store.ts'

export type * from '../shared.ts'

/** Plugin name in the Loader. */
export const name = 'dsh-plugin-aws'

/** Services the plugin uses. */
export const inject = ['mcpManager', 'credentials']

/** Route prefix under the connection's shared `/api` channel. */
const PREFIX = 'awsMcp.'

/** Endpoints the browser half calls. */
const ENDPOINTS = ['list', 'setGlobal', 'setEnabled', 'configure', 'restart'] as const

const MAX_VALUE = 2_048
const MAX_SECRET = 16_384
const MAX_EXTRA_ENV = 8_192

type Result = { ok: true; value: unknown } | { ok: false; error: { code: string; message: string } }

/** A request the browser sent with a payload this plugin refuses. */
class BadRequest extends Error {}

function payloadObject(payload: unknown): Record<string, unknown> {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) throw new BadRequest('payload must be an object')
  return payload as Record<string, unknown>
}

function stringOf(payload: Record<string, unknown>, key: string): string {
  const value = payload[key]
  if (typeof value !== 'string') throw new BadRequest(`${key} must be a string`)
  return value
}

function booleanOf(payload: Record<string, unknown>, key: string): boolean {
  const value = payload[key]
  if (typeof value !== 'boolean') throw new BadRequest(`${key} must be a boolean`)
  return value
}

function stringMap(payload: Record<string, unknown>, key: string): Record<string, string> {
  const value = payload[key]
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new BadRequest(`${key} must be an object`)
  const entries = Object.entries(value)
  if (entries.some(([, item]) => typeof item !== 'string')) throw new BadRequest(`${key} values must be strings`)
  return Object.fromEntries(entries) as Record<string, string>
}

function checkProfile(profile: string): string {
  const value = profile.trim()
  if (value !== '' && !PROFILE.test(value)) throw new BadRequest(`"${value}" is not a valid AWS profile name`)
  return value
}

function checkRegion(region: string): string {
  const value = region.trim()
  if (value !== '' && !REGION.test(value)) throw new BadRequest(`"${value}" is not an AWS region such as us-east-1`)
  return value
}

/** Validate one non-secret form value against its field. */
function checkValue(server: CatalogServer, field: FieldView, raw: string): string {
  const value = raw.trim()
  if (value === '') return ''
  if (field.kind === 'boolean') {
    if (value !== 'true' && value !== 'false') throw new BadRequest(`${field.label} must be true or false`)
    return value
  }
  if (field.kind === 'select' && !(field.options ?? []).includes(value)) throw new BadRequest(`${field.label} must be one of ${(field.options ?? []).join(', ')}`)
  if (value.length > MAX_VALUE || /[\r\n]/.test(value)) throw new BadRequest(`${field.label} must be one line of at most ${String(MAX_VALUE)} characters`)
  if (value.includes('${')) throw new BadRequest(`${field.label} must not contain "\${"`)
  // A value is passed as its own argument; a leading dash would read as a flag.
  if (value.startsWith('-')) throw new BadRequest(`${field.label} must not start with "-" (${server.name})`)
  return value
}

/** Catalog facts the page shows. */
export function serverInfo(server: CatalogServer): ServerInfo {
  const { launch } = server
  const runtime = launch.kind === 'remote' ? 'remote' : launch.kind === 'proxy' ? 'proxy' : 'local'
  const pkg = launch.kind === 'uvx' ? `${launch.package}==${launch.version}` : launch.kind === 'proxy' ? `${PROXY_PACKAGE}==${PROXY_VERSION}` : undefined
  return {
    id: server.id,
    name: server.name,
    description: server.description,
    group: server.group,
    docsUrl: server.docsUrl,
    runtime,
    ...pkg === undefined ? {} : { package: pkg },
    aws: server.aws,
    fields: (server.fields ?? []).map(({ target, ...field }) => { void target; return field }),
    ...server.requireAny === undefined ? {} : { requireAny: server.requireAny },
    permissions: { write: server.write !== undefined, sensitive: server.sensitive !== undefined },
    ...server.note === undefined ? {} : { note: server.note },
  }
}

/** Remove the noise MCP errors carry, for one status line. */
export function cleanError(message: string): string {
  return message.replace(/\s+/g, ' ').trim().slice(0, 400)
}

/**
 * State of a registered server.
 * @param status Its MCP manager status, if listed.
 * @returns The page state.
 */
export function stateOf(status: McpServerStatus | undefined): ServerState {
  if (status === undefined) return { kind: 'connecting' }
  switch (status.state) {
    case 'connected': return { kind: 'connected', toolCount: status.toolCount }
    case 'connecting': return { kind: 'connecting' }
    case 'reconnecting': return { kind: 'connecting', detail: cleanError(status.lastError) }
    case 'waiting-credentials': return { kind: 'error', message: 'A stored secret is missing. Enter it again in the server settings.' }
    case 'failed': return { kind: 'error', message: status.lastError === undefined ? `The server stopped (${status.reason}).` : cleanError(status.lastError) }
    case 'closed':
    case 'disabled': return { kind: 'off' }
  }
}

/** Test seams for the environment. */
export interface Overrides {
  readonly findUvx?: () => Promise<string | undefined>
  readonly uvxVersion?: (path: string) => Promise<string | undefined>
  readonly profiles?: () => Promise<string[]>
}

/**
 * Mount the plugin.
 * @param ctx Plugin context.
 */
export function apply(ctx: HostContext): void {
  mount(ctx, {})
}

/**
 * Mount the plugin with test seams.
 * @param ctx Plugin context.
 * @param overrides Replacements for uvx detection and the AWS profile list.
 * @returns A promise that settles once the stored settings are loaded and the enabled servers registered.
 */
export function mount(ctx: HostContext, overrides: Overrides): Promise<void> {
  const uv = uvLocator(overrides.findUvx, overrides.uvxVersion)
  const profiles = overrides.profiles ?? (() => awsProfiles())
  let settings: StoredSettings = { profile: '', region: '', servers: {} }
  /** Secret field ids with a stored value, per server. */
  const secrets = new Map<string, Set<string>>()
  /** Registered servers with the entry they were registered with. */
  const live = new Map<string, { readonly entry: string; readonly dispose: () => void }>()
  let disposed = false

  let tail: Promise<unknown> = Promise.resolve()
  const serial = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation)
    tail = result.catch(() => undefined)
    return result
  }

  const serverSettings = (id: string): ServerSettings => settings.servers[id] ?? EMPTY_SERVER
  const secretsOf = (id: string): Set<string> => secrets.get(id) ?? new Set()

  const unregister = (id: string): void => {
    const current = live.get(id)
    if (current === undefined) return
    live.delete(id)
    try { current.dispose() }
    catch (error) { ctx.logger.warn(`dsh-plugin-aws: removing ${id} failed`, error) }
  }

  /** Register what should run and remove what should not; an unchanged entry keeps its running process. */
  const sync = async (): Promise<void> => {
    if (disposed) return
    const status = await uv.status()
    for (const server of SERVERS) {
      const own = serverSettings(server.id)
      const ready = own.enabled
        && missingSettings(server, own, settings, secretsOf(server.id)).length === 0
        && (server.launch.kind === 'remote' || status.found)
      if (!ready) { unregister(server.id); continue }
      let entry: McpServerRegistration
      try { entry = registration(server, own, settings, secretsOf(server.id), status.path ?? 'uvx') }
      catch (error) {
        ctx.logger.warn(`dsh-plugin-aws: ${server.id} has invalid settings`, error)
        unregister(server.id)
        continue
      }
      const key = JSON.stringify(entry)
      if (live.get(server.id)?.entry === key) continue
      unregister(server.id)
      try { live.set(server.id, { entry: key, dispose: ctx.mcpManager.register(server.id, entry) }) }
      catch (error) { ctx.logger.warn(`dsh-plugin-aws: registering ${server.id} failed`, error) }
    }
  }

  const loadSecrets = async (server: CatalogServer): Promise<void> => {
    const set = new Set<string>()
    for (const field of server.fields ?? []) {
      if (field.kind !== 'secret') continue
      if ((await ctx.credentials.describe(secretRef(server.id, field.id))).configured) set.add(field.id)
    }
    secrets.set(server.id, set)
  }

  const ready = serial(async () => {
    settings = await readSettings(ctx.credentials)
    for (const server of SERVERS) if (server.fields?.some(field => field.kind === 'secret') === true) await loadSecrets(server)
    await sync()
  }).catch((error: unknown) => { ctx.logger.warn('dsh-plugin-aws: loading settings failed', error) })

  ctx.effect(() => () => {
    disposed = true
    for (const id of [...live.keys()]) unregister(id)
  }, 'dsh-plugin-aws: servers')

  const save = async (next: StoredSettings): Promise<void> => {
    await writeSettings(ctx.credentials, next)
    settings = next
    await sync()
  }

  const overview = async (): Promise<Overview> => {
    const status = await uv.status()
    const listed = new Map(ctx.mcpManager.list().map(view => [view.name, view.status]))
    const servers = SERVERS.map((server): ServerView => {
      const own = serverSettings(server.id)
      const set = secretsOf(server.id)
      let state: ServerState
      if (!own.enabled) state = { kind: 'off' }
      else {
        const missing = missingSettings(server, own, settings, set)
        if (missing.length > 0) state = { kind: 'needs-setup', missing }
        else if (server.launch.kind !== 'remote' && !status.found) state = { kind: 'needs-uv' }
        else if (!live.has(server.id)) state = { kind: 'error', message: 'DSH did not accept this server. See the DSH log.' }
        else state = stateOf(listed.get(server.id))
      }
      return {
        ...serverInfo(server),
        enabled: own.enabled,
        values: own.values,
        secretsSet: [...set],
        allowWrite: own.allowWrite,
        allowSensitive: own.allowSensitive,
        profile: own.profile,
        region: own.region,
        extraEnv: own.extraEnv,
        state,
      }
    })
    return { uv: status, profile: settings.profile, region: settings.region, profiles: await profiles().catch(() => []), groups: GROUPS, servers }
  }

  const serverOf = (payload: Record<string, unknown>): CatalogServer => {
    const id = stringOf(payload, 'id')
    const server = SERVER_BY_ID.get(id)
    if (server === undefined) throw new BadRequest(`unknown server ${id}`)
    return server
  }

  const setGlobal = (payload: Record<string, unknown>) => serial(async () => {
    const profile = checkProfile(stringOf(payload, 'profile'))
    const region = checkRegion(stringOf(payload, 'region'))
    await save({ ...settings, profile, region })
    return null
  })

  const setEnabled = (payload: Record<string, unknown>) => serial(async () => {
    const ids = payload.ids
    if (!Array.isArray(ids) || ids.length === 0 || ids.some(id => typeof id !== 'string' || !SERVER_BY_ID.has(id))) throw new BadRequest('ids must list catalog servers')
    const enabled = booleanOf(payload, 'enabled')
    const servers = { ...settings.servers }
    for (const id of ids as string[]) servers[id] = { ...servers[id] ?? EMPTY_SERVER, enabled }
    uv.forget()
    await save({ ...settings, servers })
    return null
  })

  const configure = (payload: Record<string, unknown>) => serial(async () => {
    const server = serverOf(payload)
    const fields = server.fields ?? []
    const values: Record<string, string> = {}
    for (const [id, raw] of Object.entries(stringMap(payload, 'values'))) {
      const field = fields.find(item => item.id === id && item.kind !== 'secret')
      if (field === undefined) throw new BadRequest(`${server.name} has no setting ${id}`)
      const value = checkValue(server, field, raw)
      if (value !== '') values[id] = value
    }
    const secretValues = stringMap(payload, 'secrets')
    for (const [id, value] of Object.entries(secretValues)) {
      if (!fields.some(item => item.id === id && item.kind === 'secret')) throw new BadRequest(`${server.name} has no secret ${id}`)
      if (value.length > MAX_SECRET) throw new BadRequest('secret is too long')
    }
    const allowWrite = booleanOf(payload, 'allowWrite')
    const allowSensitive = booleanOf(payload, 'allowSensitive')
    if (allowWrite && server.write === undefined) throw new BadRequest(`${server.name} has no write mode`)
    if (allowSensitive && server.sensitive === undefined) throw new BadRequest(`${server.name} has no sensitive data mode`)
    const extraEnv = stringOf(payload, 'extraEnv')
    if (extraEnv.length > MAX_EXTRA_ENV) throw new BadRequest('extra environment is too long')
    parseExtraEnv(extraEnv)
    const next: ServerSettings = {
      enabled: serverSettings(server.id).enabled,
      values, allowWrite, allowSensitive,
      profile: checkProfile(stringOf(payload, 'profile')),
      region: checkRegion(stringOf(payload, 'region')),
      extraEnv,
    }
    let replaced = false
    for (const [id, value] of Object.entries(secretValues)) {
      const ref = secretRef(server.id, id)
      if (value === '') await ctx.credentials.unset(ref)
      else { replaced ||= secretsOf(server.id).has(id); await ctx.credentials.set(ref, value) }
    }
    const before = live.get(server.id)
    await loadSecrets(server)
    await save({ ...settings, servers: { ...settings.servers, [server.id]: next } })
    // A new value behind the same credential template leaves the entry unchanged, so restart to pick it up.
    if (replaced && before !== undefined && live.get(server.id) === before) await ctx.mcpManager.restart(server.id)
    return null
  })

  const restart = async (payload: Record<string, unknown>): Promise<null> => {
    const server = serverOf(payload)
    uv.forget()
    await serial(sync)
    if (!live.has(server.id)) throw new BadRequest(`${server.name} is not running`)
    await ctx.mcpManager.restart(server.id)
    return null
  }

  const dispatch = async (endpoint: string, payload: unknown): Promise<unknown> => {
    const body = payloadObject(payload)
    switch (endpoint) {
      case 'list': await ready; return overview()
      case 'setGlobal': return setGlobal(body)
      case 'setEnabled': return setEnabled(body)
      case 'configure': return configure(body)
      case 'restart': return restart(body)
      default: throw new BadRequest(`unknown endpoint ${endpoint}`)
    }
  }

  const handle = async (endpoint: string, payload: unknown): Promise<Result> => {
    try { return { ok: true, value: await dispatch(endpoint, payload) } }
    catch (error) {
      if (error instanceof BadRequest || error instanceof RangeError) return { ok: false, error: { code: 'aws/bad-request', message: error.message } }
      ctx.logger.warn(`dsh-plugin-aws: ${endpoint} failed`, error)
      return { ok: false, error: { code: 'aws/failed', message: error instanceof Error ? error.message : String(error) } }
    }
  }

  ctx.inject(['connection'], (scope) => {
    for (const endpoint of ENDPOINTS) {
      const method = `${PREFIX}${endpoint}`
      const route: FetchRoute = {
        path: `/api/${method}`, methods: ['POST'], requestBody: 'buffered',
        fetch: async (request) => {
          if (request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
            return new Response('content type must be application/json', { status: 415 })
          }
          let body: unknown
          try { body = await request.json() }
          catch { return new Response('body is not JSON', { status: 400 }) }
          let envelope: Record<string, unknown>
          try { envelope = payloadObject(body) }
          catch { return new Response('body is not a JSON object', { status: 400 }) }
          const rpcId = typeof envelope.rpcId === 'string' ? envelope.rpcId : 'invalid-request'
          const result = envelope.type !== 'client-request' || envelope.method !== method
            ? { ok: false, error: { code: 'gateway/bad-request', message: `expected a client-request for ${method}` } }
            : await handle(endpoint, envelope.payload ?? {})
          return Response.json({ type: 'server-response', rpcId, result })
        },
      }
      scope.effect(() => scope.connection.fetch.register(route), `dsh-plugin-aws: /api/${method}`)
    }
  })

  return ready
}
