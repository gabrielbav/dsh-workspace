import { expect, it } from 'vitest'
import { apply, inject, name } from '../src/host/index.ts'
import type { FetchRoute, HostContext, SessionController } from '../src/host/dsh.ts'

/** Mount the plugin on a recording context with an empty session store. */
function mount(controller?: SessionController) {
  const disposers: (() => void | Promise<void>)[] = []
  const routes = new Map<string, FetchRoute>()
  const ctx: HostContext = {
    sessionPersistence: { list: async () => [], stat: async () => undefined, open: async () => ({ close: async () => {} }), config: { root: '/tmp' } },
    workspaceRegistry: { get: () => undefined, list: () => [], delete: async () => false, pinnedSessionIds: [], unpinSession: async () => {} },
    sessions: { get: () => undefined },
    agents: { get: () => undefined },
    logger: { warn: () => {}, info: () => {} },
    get: () => controller,
    emit: () => {},
    waterfall: (_name, _request, next) => next(),
    effect: (execute) => { disposers.push(execute()) },
    inject: (_names, callback) => {
      callback({ ...ctx, connection: { fetch: { register: (route) => { routes.set(route.path, route); return () => { routes.delete(route.path) } } } } })
    },
  }
  apply(ctx)
  const post = (path: string, body: string, type = 'application/json') =>
    routes.get(path)!.fetch(new Request('http://host/api', { method: 'POST', headers: { 'content-type': type }, body }))
  const call = async (endpoint: string, payload: unknown) => {
    const method = `sessionDelete.${endpoint}`
    const response = await post(`/api/${method}`, JSON.stringify({ type: 'client-request', rpcId: 'r1', method, payload }))
    return (await response.json() as { result: { ok: boolean; value?: unknown; error?: { code: string; message: string } } }).result
  }
  return { routes, post, call, dispose: async () => { for (const dispose of disposers.reverse()) await dispose() } }
}

it('exports a function plugin that needs the session and workspace services', () => {
  expect(name).toBe('dsh-plugin-session-delete')
  expect(inject).toEqual(['sessionPersistence', 'workspaceRegistry', 'sessions', 'agents'])
})

it('registers its routes and removes them on disposal', async () => {
  const { routes, dispose } = mount()
  expect([...routes.keys()].sort()).toEqual(['capabilities', 'deleteSession', 'deleteWorkspace'].map(item => `/api/sessionDelete.${item}`))
  await dispose()
  expect(routes.size).toBe(0)
})

it('reports whether the session controller can release idle sessions', async () => {
  expect(await mount().call('capabilities', {})).toEqual({ ok: true, value: { releaseIdle: false } })
  expect(await mount({}).call('capabilities', {})).toEqual({ ok: true, value: { releaseIdle: false } })
  expect(await mount({ releaseAgent: async () => ({ released: true }) }).call('capabilities', {}))
    .toEqual({ ok: true, value: { releaseIdle: true } })
})

it('answers deletion requests and refuses malformed ones', async () => {
  const { call, post } = mount()
  expect(await call('deleteSession', { sessionId: 'missing' }))
    .toEqual({ ok: true, value: { deleted: [], kept: [{ sessionId: 'missing', reason: 'not-found' }] } })
  expect(await call('deleteSession', { sessionId: '' })).toMatchObject({ ok: false, error: { code: 'session-delete/bad-request' } })
  expect(await call('deleteSession', [])).toMatchObject({ ok: false, error: { code: 'session-delete/bad-request' } })
  expect(await call('deleteWorkspace', { workspaceId: 'missing' })).toMatchObject({ ok: false, error: { message: 'the workspace no longer exists' } })
  expect((await post('/api/sessionDelete.deleteSession', '{}', 'text/plain')).status).toBe(415)
  expect((await post('/api/sessionDelete.deleteSession', 'not json')).status).toBe(400)
  expect((await post('/api/sessionDelete.deleteSession', '[]')).status).toBe(400)
  const wrong = await post('/api/sessionDelete.deleteSession', JSON.stringify({ type: 'client-request', method: 'sessionDelete.other', payload: {} }))
  expect(await wrong.json()).toMatchObject({ rpcId: 'invalid-request', result: { ok: false, error: { code: 'gateway/bad-request' } } })
})
