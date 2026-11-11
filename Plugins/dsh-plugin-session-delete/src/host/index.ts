/**
 * Session delete, Host half: deletes Sessions and Workspaces permanently on request from the browser half, over
 * exact `/api/sessionDelete.<endpoint>` routes. The connection answers those routes only for the owner. Unloading an
 * idle Session uses the session controller's `releaseAgent` when this DSH provides it; without it, a Session loaded
 * since DSH started is kept until DSH restarts.
 */
import type { Capabilities } from '../shared.ts'
import { sessionDeleter } from './delete.ts'
import type { FetchRoute, HostContext } from './dsh.ts'

export type * from '../shared.ts'

/** Plugin name in the Loader. */
export const name = 'dsh-plugin-session-delete'

/** Services the deletion reads and changes. */
export const inject = ['sessionPersistence', 'workspaceRegistry', 'sessions', 'agents']

/** Route prefix under the connection's shared `/api` channel. */
const PREFIX = 'sessionDelete.'

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

/**
 * Mount the plugin.
 * @param ctx Plugin context.
 */
export function apply(ctx: HostContext): void {
  const release = (): ((id: string) => Promise<import('./dsh.ts').ReleaseResult>) | undefined => {
    const controller = ctx.get('sessionController')
    return typeof controller?.releaseAgent === 'function' ? controller.releaseAgent.bind(controller) : undefined
  }
  const deleter = sessionDeleter({
    persistence: ctx.sessionPersistence,
    registry: ctx.workspaceRegistry,
    liveHeader: id => ctx.sessions.get(id)?.header,
    isLive: id => ctx.sessions.get(id) !== undefined || ctx.agents.get(id) !== undefined,
    get release() { return release() },
    activity: id => ctx.waterfall('workspace/session-activity', { sessionId: id }, () => Promise.resolve([])),
    removed: (id) => { ctx.emit('api-session/removed', id) },
    warn: (message, error) => { ctx.logger.warn(message, error) },
  })

  const dispatch = async (endpoint: string, payload: unknown): Promise<unknown> => {
    switch (endpoint) {
      case 'capabilities': return { releaseIdle: release() !== undefined } satisfies Capabilities
      case 'deleteSession': return deleter.deleteSession(stringField(payload, 'sessionId'))
      case 'deleteWorkspace': {
        const report = await deleter.deleteWorkspace(stringField(payload, 'workspaceId'))
        if (report === undefined) throw new BadRequest('the workspace no longer exists')
        return report
      }
      default: throw new BadRequest(`unknown endpoint ${endpoint}`)
    }
  }

  const handle = async (endpoint: string, payload: unknown): Promise<Result> => {
    try { return { ok: true, value: await dispatch(endpoint, payload) } }
    catch (error) {
      if (error instanceof BadRequest) return { ok: false, error: { code: 'session-delete/bad-request', message: error.message } }
      ctx.logger.warn('session-delete: request failed', error)
      return { ok: false, error: { code: 'session-delete/failed', message: error instanceof Error ? error.message : String(error) } }
    }
  }

  ctx.inject(['connection'], (scope) => {
    for (const endpoint of ['capabilities', 'deleteSession', 'deleteWorkspace']) {
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
      scope.effect(() => scope.connection.fetch.register(route), `session-delete: /api/${method}`)
    }
  })
}
