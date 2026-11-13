/**
 * Connectors, Host half. Provides the `connectors` service other plugins register connectors with, registers the
 * built-in and custom connectors through it, and answers the Connectors settings page over exact
 * `/api/connectors.<endpoint>` routes, which the connection answers only for the owner. Tokens stay on the Host: the
 * page sends a pasted token once and never reads one back.
 */
import type { ConnectorView } from '../shared.ts'
import { builtins, type BuiltinOptions } from './builtins.ts'
import { connectors, DEFAULT_TIMINGS, type ConnectorDeps } from './connectors.ts'
import { customDefinition, customId, customUrl, detectAuth, readCustom, writeCustom, type CustomConnector } from './custom.ts'
import type { FetchRoute, HostContext } from './dsh.ts'
import { checkPackage, installPackage, type PluginManager } from './packages.ts'

export type * from '../shared.ts'
export type * from './api.ts'

/** Plugin name in the Loader. */
export const name = 'dsh-connectors'

/** Services the plugin uses; `pluginManager` is optional and read with `ctx.get`. */
export const inject = ['mcpManager', 'credentials']

/** Route prefix under the connection's shared `/api` channel. */
const PREFIX = 'connectors.'

/** Endpoints the browser half calls. */
const ENDPOINTS = [
  'capabilities', 'list', 'beginOAuth', 'cancelOAuth', 'setToken', 'reconnect', 'disconnect',
  'addCustom', 'removeCustom', 'checkPackage', 'installPackage',
] as const

type Result = { ok: true; value: unknown } | { ok: false; error: { code: string; message: string } }

/** A request the browser sent with a payload this plugin refuses. */
class BadRequest extends Error {}

function payloadObject(payload: unknown): Record<string, unknown> {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) throw new BadRequest('payload must be an object')
  return payload as Record<string, unknown>
}

function stringField(payload: unknown, key: string): string {
  const value = payloadObject(payload)[key]
  if (typeof value !== 'string' || value === '') throw new BadRequest(`${key} must be a non-empty string`)
  return value
}

function stringMap(payload: unknown, key: string): Record<string, string> {
  const value = payloadObject(payload)[key]
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new BadRequest(`${key} must be an object`)
  const entries = Object.entries(value)
  if (entries.some(([, item]) => typeof item !== 'string')) throw new BadRequest(`${key} values must be strings`)
  return Object.fromEntries(entries) as Record<string, string>
}

/**
 * Read the plugin config.
 * @param config Raw config from the profile (`- id: connectors` row).
 * @returns Built-in connector options.
 * @throws When a GitHub app is configured without a client id or with a malformed field.
 */
export function parseConfig(config: unknown): BuiltinOptions {
  if (typeof config !== 'object' || config === null) return {}
  return parseGitHub((config as Record<string, unknown>).github)
}

function parseGitHub(github: unknown): BuiltinOptions {
  if (github === undefined) return {}
  if (typeof github !== 'object' || github === null) throw new Error('dsh-connectors: config.github must be an object')
  const { clientId, clientSecret, appSlug } = github as Record<string, unknown>
  if (typeof clientId !== 'string' || clientId === '') throw new Error('dsh-connectors: config.github.clientId is required')
  for (const [key, value] of Object.entries({ clientSecret, appSlug })) {
    if (value !== undefined && typeof value !== 'string') throw new Error(`dsh-connectors: config.github.${key} must be a string`)
  }
  return {
    github: {
      clientId,
      ...typeof clientSecret === 'string' ? { clientSecret } : {},
      ...typeof appSlug === 'string' ? { appSlug } : {},
    },
  }
}

/** Test seams for the OAuth protocol, fetch, timings and clock. */
export type Overrides = Partial<Pick<ConnectorDeps, 'protocol' | 'fetch' | 'timings' | 'now'>>

/**
 * Mount the plugin.
 * @param ctx Plugin context.
 * @param config Plugin config.
 */
export function apply(ctx: HostContext, config?: unknown): void {
  mount(ctx, parseConfig(config), {})
}

/**
 * Mount the plugin with test seams.
 * @param ctx Plugin context.
 * @param options Built-in connector options.
 * @param overrides Replacements for the network, timings and clock.
 */
export function mount(ctx: HostContext, options: BuiltinOptions, overrides: Overrides): void {
  const fetchFn = overrides.fetch ?? globalThis.fetch.bind(globalThis)
  const registry = connectors({
    mcp: ctx.mcpManager,
    credentials: ctx.credentials,
    logger: ctx.logger,
    fetch: fetchFn,
    timings: overrides.timings ?? DEFAULT_TIMINGS,
    ...overrides.protocol === undefined ? {} : { protocol: overrides.protocol },
    ...overrides.now === undefined ? {} : { now: overrides.now },
  })
  ctx.effect(() => () => { registry.dispose() }, 'dsh-connectors: registry')
  ctx.provide('connectors', registry.service)
  for (const definition of builtins(options)) {
    ctx.effect(() => registry.service.register(definition), `dsh-connectors: ${definition.id}`)
  }

  // Custom connectors: registered from the stored list, added and removed by the page.
  const custom = new Map<string, { readonly entry: CustomConnector; readonly remove: () => void }>()
  let customTail: Promise<unknown> = Promise.resolve()
  const serial = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = customTail.then(operation)
    customTail = result.catch(() => undefined)
    return result
  }
  const mountCustom = (entry: CustomConnector): void => {
    custom.set(entry.id, { entry, remove: registry.service.register(customDefinition(entry)) })
  }
  ctx.effect(() => {
    void serial(async () => {
      for (const entry of await readCustom(ctx.credentials)) {
        try { mountCustom(entry) }
        catch (error) { ctx.logger.warn(`dsh-connectors: custom connector ${entry.id} was not added`, error) }
      }
    }).catch((error: unknown) => { ctx.logger.warn('dsh-connectors: reading custom connectors failed', error) })
    return () => {
      for (const item of custom.values()) item.remove()
      custom.clear()
    }
  }, 'dsh-connectors: custom connectors')

  const addCustom = (payload: unknown) => serial(async () => {
    const label = stringField(payload, 'name').trim().slice(0, 60)
    if (label === '') throw new BadRequest('name must not be empty')
    const url = customUrl(stringField(payload, 'url'))
    const id = customId(label, new Set(registry.list().map(view => view.id)))
    const entry: CustomConnector = { id, name: label, url, auth: await detectAuth(url, overrides.protocol) }
    await writeCustom(ctx.credentials, [...[...custom.values()].map(item => item.entry), entry])
    mountCustom(entry)
    return { id, auth: entry.auth }
  })
  const removeCustom = (id: string) => serial(async () => {
    const item = custom.get(id)
    if (item === undefined) throw new BadRequest(`${id} is not a custom connector`)
    await registry.disconnect(id)
    item.remove()
    custom.delete(id)
    await writeCustom(ctx.credentials, [...custom.values()].map(other => other.entry))
    return null
  })

  const manager = (): PluginManager => {
    const found = ctx.get('pluginManager')
    if (found === undefined) throw new BadRequest('This DSH has no plugin manager, so connector packages cannot be installed.')
    return found
  }
  const list = (): ConnectorView[] => registry.list().map(view => custom.has(view.id) ? { ...view, custom: true } : view)

  const id = (payload: unknown): string => stringField(payload, 'id')
  const dispatch = async (endpoint: string, payload: unknown): Promise<unknown> => {
    switch (endpoint) {
      case 'capabilities': return { packages: ctx.get('pluginManager') !== undefined }
      case 'list': return list()
      case 'beginOAuth': return registry.beginOAuth(id(payload))
      case 'cancelOAuth': registry.cancelOAuth(id(payload)); return null
      case 'setToken': await registry.setToken(id(payload), stringMap(payload, 'values')); return null
      case 'reconnect': await registry.reconnect(id(payload)); return null
      case 'disconnect': await registry.disconnect(id(payload)); return null
      case 'addCustom': return addCustom(payload)
      case 'removeCustom': return removeCustom(id(payload))
      case 'checkPackage': return checkPackage(manager(), stringField(payload, 'spec'), fetchFn)
      case 'installPackage': {
        const gate = payloadObject(payload).gateAcknowledged
        if (gate !== undefined && typeof gate !== 'string') throw new BadRequest('gateAcknowledged must be a string')
        // Re-check the manifest at install time: the page's earlier answer is not trusted.
        const checked = await checkPackage(manager(), `${stringField(payload, 'name')}@${stringField(payload, 'version')}`, fetchFn)
        if (!checked.ok) throw new BadRequest(checked.reason)
        return installPackage(manager(), checked.name, checked.version, gate)
      }
      default: throw new BadRequest(`unknown endpoint ${endpoint}`)
    }
  }

  const handle = async (endpoint: string, payload: unknown): Promise<Result> => {
    try { return { ok: true, value: await dispatch(endpoint, payload) } }
    catch (error) {
      if (error instanceof BadRequest || error instanceof RangeError) return { ok: false, error: { code: 'connectors/bad-request', message: error.message } }
      ctx.logger.warn(`dsh-connectors: ${endpoint} failed`, error)
      return { ok: false, error: { code: 'connectors/failed', message: error instanceof Error ? error.message : String(error) } }
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
          catch (error) { void error; return new Response('body is not JSON', { status: 400 }) }
          let envelope: Record<string, unknown>
          try { envelope = payloadObject(body) }
          catch (error) { void error; return new Response('body is not a JSON object', { status: 400 }) }
          const rpcId = typeof envelope.rpcId === 'string' ? envelope.rpcId : 'invalid-request'
          const result = envelope.type !== 'client-request' || envelope.method !== method
            ? { ok: false, error: { code: 'gateway/bad-request', message: `expected a client-request for ${method}` } }
            : await handle(endpoint, envelope.payload ?? {})
          return Response.json({ type: 'server-response', rpcId, result })
        },
      }
      scope.effect(() => scope.connection.fetch.register(route), `dsh-connectors: /api/${method}`)
    }
  })
}
