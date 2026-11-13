import { afterEach, expect, it, vi } from 'vitest'
import { mount, parseConfig } from '../src/host/index.ts'
import { cleanError, DEFAULT_TIMINGS, parseStored, stateOf, tokenRef } from '../src/host/connectors.ts'
import { AZURE_DEVOPS_MCP } from '../src/host/builtins.ts'
import { connectorIds } from '../src/host/packages.ts'
import { customId, customUrl } from '../src/host/custom.ts'
import type { ConnectorsService } from '../src/host/api.ts'
import type { BuiltinOptions } from '../src/host/builtins.ts'
import type { CredentialRecord, Credentials, FetchRoute, HostContext, McpServerRegistration, McpServerView } from '../src/host/dsh.ts'
import type { OAuthProtocol } from '../src/host/oauth.ts'
import type { PluginManager } from '../src/host/packages.ts'
import type { ConnectorView } from '../src/shared.ts'

const disposers: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const dispose of disposers.splice(0).reverse()) await dispose() })

/** In-memory credentials store. */
function memoryCredentials(refs = new Map<string, string>(), records = new Map<string, CredentialRecord>()): Credentials & { refs: Map<string, string>; records: Map<string, CredentialRecord> } {
  return {
    refs, records,
    describe: async ref => ({ configured: refs.has(ref), writable: true }),
    set: async (ref, value) => { refs.set(ref, value) },
    unset: async (ref) => { refs.delete(ref) },
    readRecord: async key => records.get(key),
    modifyRecord: async (key, mutate) => { const next = await mutate(records.get(key)); if (next !== undefined) records.set(key, next); return next },
    deleteRecord: async (key) => { records.delete(key) },
  }
}

/** A fake MCP manager recording registrations. */
function fakeManager() {
  const registered = new Map<string, McpServerRegistration>()
  const statuses = new Map<string, McpServerView['status']>()
  const restarts: string[] = []
  return {
    registered, statuses, restarts,
    register: (name: string, entry: McpServerRegistration) => {
      if (registered.has(name)) throw new Error(`server "${name}" is already configured or registered`)
      registered.set(name, entry)
      return () => { registered.delete(name) }
    },
    list: (): McpServerView[] => [...registered.keys()].map(name => ({ name, configured: false, status: statuses.get(name) ?? { state: 'connecting', attempt: 0 } })),
    restart: async (name: string) => { restarts.push(name) },
  }
}

/** An authorization server that issues `access-<n>` / `refresh-<n>` tokens. */
function fakeProtocol(options: { expiresIn?: number; dcr?: boolean } = {}) {
  const expiresIn = 'expiresIn' in options ? options.expiresIn : 3600
  let issued = 0
  const calls: string[] = []
  const tokens = () => {
    issued++
    return { access_token: `access-${issued}`, token_type: 'Bearer', refresh_token: `refresh-${issued}`, ...expiresIn === undefined ? {} : { expires_in: expiresIn } }
  }
  const metadata = {
    issuer: 'https://auth.example', authorization_endpoint: 'https://auth.example/authorize', token_endpoint: 'https://auth.example/token',
    ...options.dcr === false ? {} : { registration_endpoint: 'https://auth.example/register' },
    response_types_supported: ['code'], scopes_supported: ['openid', 'offline_access'],
  }
  const protocol: OAuthProtocol = {
    discoverOAuthServerInfo: (async (url: string) => {
      calls.push(`discover ${String(url)}`)
      return { authorizationServerUrl: 'https://auth.example', authorizationServerMetadata: metadata, resourceMetadata: { resource: String(url), scopes_supported: ['mcp'] } }
    }) as never,
    registerClient: (async (_url: string, { clientMetadata }: { clientMetadata: { redirect_uris: string[]; scope?: string } }) => {
      calls.push(`register ${clientMetadata.scope ?? ''}`)
      return { client_id: 'client-1', ...clientMetadata }
    }) as never,
    startAuthorization: (async (_url: string, { redirectUrl, state, clientInformation }: { redirectUrl: string; state: string; clientInformation: { client_id: string } }) => {
      calls.push(`start ${clientInformation.client_id}`)
      const url = new URL('https://auth.example/authorize')
      url.searchParams.set('redirect_uri', redirectUrl)
      url.searchParams.set('state', state)
      return { authorizationUrl: url, codeVerifier: 'verifier' }
    }) as never,
    exchangeAuthorization: (async (_url: string, { authorizationCode, codeVerifier, clientInformation }: { authorizationCode: string; codeVerifier: string; clientInformation: { client_id: string; client_secret?: string } }) => {
      calls.push(`exchange ${authorizationCode} ${codeVerifier} ${clientInformation.client_id}${clientInformation.client_secret === undefined ? '' : ` ${clientInformation.client_secret}`}`)
      return tokens()
    }) as never,
    refreshAuthorization: (async (_url: string, { refreshToken, clientInformation }: { refreshToken: string; clientInformation: { client_id: string; client_secret?: string } }) => {
      calls.push(`refresh ${refreshToken} ${clientInformation.client_id}${clientInformation.client_secret === undefined ? '' : ` ${clientInformation.client_secret}`}`)
      if (refreshToken === 'revoked') throw new Error('invalid_grant: refresh token revoked')
      return tokens()
    }) as never,
  }
  return { protocol, calls }
}

interface SetupOptions {
  credentials?: ReturnType<typeof memoryCredentials>
  protocol?: OAuthProtocol
  fetch?: typeof fetch
  now?: () => number
  builtins?: BuiltinOptions
  pluginManager?: PluginManager
}

function setup(options: SetupOptions = {}) {
  const routes = new Map<string, FetchRoute>()
  const credentials = options.credentials ?? memoryCredentials()
  const mcp = fakeManager()
  const local: (() => void | Promise<void>)[] = []
  let service: ConnectorsService | undefined
  const ctx: HostContext = {
    mcpManager: mcp,
    credentials,
    logger: { warn: () => {}, info: () => {} },
    effect: (execute) => { local.push(execute()) },
    provide: (_name, value) => { service = value; return () => { service = undefined } },
    get: () => options.pluginManager,
    inject: (_names, callback) => {
      callback({ ...ctx, connection: { fetch: { register: (route) => { routes.set(route.path, route); return () => { routes.delete(route.path) } } } } })
    },
  }
  mount(ctx, options.builtins ?? {}, {
    timings: { ...DEFAULT_TIMINGS, signInTimeoutMs: 5_000 },
    ...options.protocol === undefined ? {} : { protocol: options.protocol },
    ...options.fetch === undefined ? {} : { fetch: options.fetch },
    ...options.now === undefined ? {} : { now: options.now },
  })
  const dispose = async () => { for (const item of local.splice(0).reverse()) await item() }
  disposers.push(dispose)
  const call = async (endpoint: string, payload: unknown = {}) => {
    const method = `connectors.${endpoint}`
    const response = await routes.get(`/api/${method}`)!.fetch(new Request('http://host/api', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'r', method, payload }),
    }))
    return (await response.json() as { result: { ok: boolean; value?: unknown; error?: { code: string; message: string } } }).result
  }
  const list = async () => (await call('list')).value as ConnectorView[]
  const row = async (id: string) => (await list()).find(item => item.id === id)!
  return { routes, credentials, mcp, call, list, row, dispose, service: () => service! }
}

const flush = () => new Promise(resolve => setTimeout(resolve, 20))

const bearerTo = (url: string) => ({ credential }: { credential: string }) => ({ transport: 'streamable-http' as const, url, headers: { Authorization: `Bearer ${credential}` } })

/** Run the browser half of a sign-in against the loopback callback. */
async function signIn(call: ReturnType<typeof setup>['call'], id: string, code = 'the-code') {
  const started = await call('beginOAuth', { id })
  expect(started.ok).toBe(true)
  const authorize = new URL((started.value as { url: string }).url)
  const back = await fetch(`${authorize.searchParams.get('redirect_uri')!}?code=${code}&state=${authorize.searchParams.get('state')!}`)
  expect(back.status).toBe(200)
  await flush()
  return authorize
}

it('lists the built-in connectors and provides the connectors service', async () => {
  const { routes, list, service, dispose } = setup()
  expect([...routes.keys()]).toContain('/api/connectors.list')
  expect((await list()).map(({ id, auth, setup }) => `${id}:${auth.join('+') || 'setup'}${setup === undefined ? '' : '!'}`)).toEqual([
    'granola:oauth', 'github:token', 'gitlab:oauth', 'linear:oauth', 'atlassian:oauth', 'trello:oauth', 'azure-devops:token',
  ])
  expect((await list()).every(item => item.state.kind === 'disconnected')).toBe(true)
  expect(service().list()).toHaveLength(7)
  await dispose()
  expect(routes.size).toBe(0)
})

it('signs in to Granola through the loopback callback and registers the server with a credential template', async () => {
  const { protocol, calls } = fakeProtocol()
  const { call, row, credentials, mcp } = setup({ protocol })
  const started = await call('beginOAuth', { id: 'granola' })
  const authorize = new URL((started.value as { url: string }).url)
  expect((await row('granola')).state).toEqual({ kind: 'authorizing' })
  const redirect = new URL(authorize.searchParams.get('redirect_uri')!)
  expect(redirect.hostname).toBe('127.0.0.1')

  const forged = await fetch(`${redirect.href}?code=evil&state=other`)
  expect(forged.status).toBe(400)
  expect((await row('granola')).state).toEqual({ kind: 'authorizing' })

  const back = await fetch(`${redirect.href}?code=the-code&state=${authorize.searchParams.get('state')!}`)
  expect(await back.text()).toContain('Connected')
  await flush()

  expect(calls).toEqual(['discover https://mcp.granola.ai/mcp', 'register mcp offline_access', 'start client-1', 'exchange the-code verifier client-1'])
  expect(credentials.refs.get('DSH_CONNECTORS_GRANOLA_TOKEN')).toBe('access-1')
  expect(credentials.records.get('dsh-connectors/granola')).toMatchObject({ kind: 'grant', payload: { via: 'oauth', grant: { clientId: 'client-1', refreshToken: 'refresh-1' } } })
  expect(mcp.registered.get('granola')).toEqual({
    transport: 'streamable-http', url: 'https://mcp.granola.ai/mcp', headers: { Authorization: 'Bearer ${credential:DSH_CONNECTORS_GRANOLA_TOKEN}' },
  })
  mcp.statuses.set('granola', { state: 'connected', toolCount: 20 })
  expect(await row('granola')).toMatchObject({ via: 'oauth', registered: true, state: { kind: 'connected', toolCount: 20 } })
})

it('signs in on a fixed callback port with extra parameters, and shows setup before a definition has a method', async () => {
  const { protocol } = fakeProtocol({ dcr: false })
  const port = 40000 + Math.floor(Math.random() * 20000)
  const { call, row, service } = setup({ protocol })
  service().register({
    id: 'fixed', name: 'Fixed', description: '',
    oauth: { resourceUrl: 'https://mcp.fixed.example/mcp', client: { clientId: 'c', clientSecret: 's' }, callbackPort: port, authorizationParams: { access_type: 'offline' } },
    server: bearerTo('https://mcp.fixed.example/mcp'),
  })
  service().register({ id: 'later', name: 'Later', description: '', setup: { reason: 'Needs an app' }, server: bearerTo('https://x.example') })
  expect(await row('later')).toMatchObject({ auth: [], setup: { reason: 'Needs an app' } })
  const authorize = await signIn(call, 'fixed')
  expect(authorize.searchParams.get('redirect_uri')).toBe(`http://127.0.0.1:${port}/callback`)
  expect(authorize.searchParams.get('access_type')).toBe('offline')
})

it('signs in to GitLab the same way', async () => {
  const { protocol } = fakeProtocol()
  const { call, mcp } = setup({ protocol })
  await signIn(call, 'gitlab')
  expect(mcp.registered.get('gitlab')).toMatchObject({ url: 'https://gitlab.com/api/v4/mcp', headers: { Authorization: 'Bearer ${credential:DSH_CONNECTORS_GITLAB_TOKEN}' } })
})

it('signs in to GitHub with a configured GitHub App, renews with its secret, and still accepts a token', async () => {
  const { protocol, calls } = fakeProtocol({ dcr: false })
  const fetchFn = vi.fn(async () => Response.json({ login: 'octocat' })) as unknown as typeof fetch
  const { call, row, mcp, credentials } = setup({ protocol, fetch: fetchFn, builtins: { github: { clientId: 'Iv1.app', clientSecret: 's3cret', appSlug: 'dsh-connectors' } } })
  expect((await row('github')).auth).toEqual(['oauth', 'token'])
  await signIn(call, 'github')
  expect(calls.some(line => line.startsWith('register'))).toBe(false)
  expect(calls).toContain('exchange the-code verifier Iv1.app s3cret')
  expect(await row('github')).toMatchObject({ account: 'octocat', via: 'oauth', setupUrl: 'https://github.com/apps/dsh-connectors/installations/new' })
  expect(mcp.registered.get('github')?.transport).toBe('streamable-http')
  expect(credentials.refs.get('DSH_CONNECTORS_GITHUB_TOKEN')).toBe('access-1')
})

it('renews a GitHub App token with the app secret', async () => {
  const { protocol, calls } = fakeProtocol({ dcr: false })
  const credentials = memoryCredentials(new Map(), new Map([['dsh-connectors/github', {
    kind: 'grant', payload: { via: 'oauth', grant: { authorizationServerUrl: 'https://auth.example', resource: 'https://api.githubcopilot.com/mcp/', clientId: 'Iv1.app', refreshToken: 'r0', expiresAt: 0 } },
  }]]))
  setup({ protocol, credentials, fetch: (async () => Response.json({ login: 'octocat' })) as unknown as typeof fetch, builtins: { github: { clientId: 'Iv1.app', clientSecret: 's3cret' } } })
  await flush()
  expect(calls).toContain('refresh r0 Iv1.app s3cret')
})

it('refuses an authorization URL that is not a web page', async () => {
  const { protocol } = fakeProtocol()
  const evil: OAuthProtocol = { ...protocol, startAuthorization: (async () => ({ authorizationUrl: new URL('javascript:alert(1)'), codeVerifier: 'v' })) as never }
  const { call, row } = setup({ protocol: evil })
  expect(await call('beginOAuth', { id: 'granola' })).toMatchObject({ ok: false, error: { message: expect.stringContaining('not http(s)') } })
  expect((await row('granola')).state).toEqual({ kind: 'disconnected' })
})

it('shows an Azure DevOps record without an organization as an error instead of starting the server', async () => {
  const { mcp, row } = setup({ credentials: memoryCredentials(new Map([['DSH_CONNECTORS_AZURE_DEVOPS_TOKEN', 'x']])) })
  await flush()
  expect(mcp.registered.has('azure-devops')).toBe(false)
  expect((await row('azure-devops')).state).toMatchObject({ kind: 'error', message: expect.stringContaining('organization') })
})

it('refuses a sign-in without client registration when no client is configured', async () => {
  const { protocol } = fakeProtocol({ dcr: false })
  const { call } = setup({ protocol })
  expect(await call('beginOAuth', { id: 'gitlab' })).toMatchObject({ ok: false, error: { message: expect.stringContaining('dynamic client registration') } })
})

it('reports a refused sign-in and a cancelled one', async () => {
  const { protocol } = fakeProtocol()
  const { call, row, mcp } = setup({ protocol })
  const first = new URL(((await call('beginOAuth', { id: 'granola' })).value as { url: string }).url)
  await fetch(`${first.searchParams.get('redirect_uri')!}?error=access_denied&error_description=User%20said%20no&state=${first.searchParams.get('state')!}`)
  await flush()
  expect((await row('granola')).state).toEqual({ kind: 'error', message: 'The sign-in was refused: User said no' })

  const second = new URL(((await call('beginOAuth', { id: 'granola' })).value as { url: string }).url)
  await call('cancelOAuth', { id: 'granola' })
  await flush()
  expect((await row('granola')).state).toEqual({ kind: 'disconnected' })
  await expect(fetch(second.searchParams.get('redirect_uri')!)).rejects.toThrow()
  expect(mcp.registered.size).toBe(0)
})

it('reads the 0.1 record formats', async () => {
  const legacy = { authorizationServerUrl: 'https://auth.example', resource: 'https://mcp.granola.ai/mcp', clientId: 'c', refreshToken: 'r', expiresAt: 5 }
  expect(parseStored(legacy)).toEqual({ via: 'oauth', grant: legacy })
  expect(parseStored({ account: 'me' })).toEqual({ via: 'token', account: 'me' })
  const { protocol } = fakeProtocol()
  const credentials = memoryCredentials(new Map([['DSH_CONNECTORS_GRANOLA_TOKEN', 'a']]), new Map([['dsh-connectors/granola', { kind: 'grant', payload: { ...legacy, expiresAt: Date.now() + 3_600_000 } }]]))
  const { mcp } = setup({ protocol, credentials })
  await flush()
  expect(mcp.registered.has('granola')).toBe(true)
})

it('renews an expired token on start before registering, and asks to connect again when the grant is revoked', async () => {
  const { protocol, calls } = fakeProtocol()
  const grant = (refreshToken: string) => new Map<string, CredentialRecord>([['dsh-connectors/granola', {
    kind: 'grant', payload: { via: 'oauth', grant: { authorizationServerUrl: 'https://auth.example', resource: 'https://mcp.granola.ai/mcp', clientId: 'client-1', refreshToken, expiresAt: 1_000 } },
  }]])
  const ok = setup({ protocol, credentials: memoryCredentials(new Map([['DSH_CONNECTORS_GRANOLA_TOKEN', 'old']]), grant('refresh-0')), now: () => 10_000 })
  await flush()
  expect(calls).toContain('refresh refresh-0 client-1')
  expect(ok.credentials.refs.get('DSH_CONNECTORS_GRANOLA_TOKEN')).toBe('access-1')
  expect(ok.mcp.registered.has('granola')).toBe(true)

  const revoked = setup({ protocol, credentials: memoryCredentials(new Map(), grant('revoked')), now: () => 10_000 })
  await flush()
  expect(revoked.mcp.registered.has('granola')).toBe(false)
  expect((await revoked.row('granola')).state).toEqual({ kind: 'error', message: 'The sign-in expired. Connect again.' })
})

it('registers a connector once a renewal that failed at start succeeds on retry', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  try {
    const { protocol, calls } = fakeProtocol()
    let offline = true
    const flaky: OAuthProtocol = { ...protocol, refreshAuthorization: (async (...args: Parameters<OAuthProtocol['refreshAuthorization']>) => {
      if (offline) throw new Error('fetch failed: ENOTFOUND')
      return protocol.refreshAuthorization(...args)
    }) as OAuthProtocol['refreshAuthorization'] }
    const credentials = memoryCredentials(new Map(), new Map([['dsh-connectors/granola', {
      kind: 'grant', payload: { via: 'oauth', grant: { authorizationServerUrl: 'https://auth.example', resource: 'https://mcp.granola.ai/mcp', clientId: 'c', refreshToken: 'r0', expiresAt: 0 } },
    }]]))
    const { mcp, row } = setup({ protocol: flaky, credentials })
    await vi.advanceTimersByTimeAsync(10)
    expect(mcp.registered.has('granola')).toBe(false)
    expect((await row('granola')).state).toMatchObject({ kind: 'error', message: expect.stringContaining('ENOTFOUND') })
    offline = false
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMINGS.refreshRetryMs)
    expect(calls).toContain('refresh r0 c')
    expect(mcp.registered.has('granola')).toBe(true)
  } finally {
    vi.useRealTimers()
  }
})

it('schedules a renewal ahead of expiry', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  try {
    const { protocol, calls } = fakeProtocol({ expiresIn: 600 })
    const credentials = memoryCredentials(new Map([['DSH_CONNECTORS_GRANOLA_TOKEN', 'a']]), new Map([['dsh-connectors/granola', {
      kind: 'grant', payload: { via: 'oauth', grant: { authorizationServerUrl: 'https://auth.example', resource: 'https://mcp.granola.ai/mcp', clientId: 'c', refreshToken: 'r0', expiresAt: Date.now() + 10 * 60_000 } },
    }]]))
    setup({ protocol, credentials })
    await vi.advanceTimersByTimeAsync(4 * 60_000)
    expect(calls).toEqual([])
    await vi.advanceTimersByTimeAsync(2 * 60_000)
    expect(calls).toEqual(['discover https://mcp.granola.ai/mcp', 'refresh r0 c'])
    expect(credentials.refs.get('DSH_CONNECTORS_GRANOLA_TOKEN')).toBe('access-1')
  } finally {
    vi.useRealTimers()
  }
})

it('connects GitHub with a personal access token it checks first, and disconnects it', async () => {
  const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const auth = new Headers(init?.headers).get('authorization')
    return auth === 'Bearer good' ? Response.json({ login: 'octocat' }) : new Response('', { status: 401 })
  }) as unknown as typeof fetch
  const { call, row, credentials, mcp } = setup({ fetch: fetchFn })

  expect(await call('setToken', { id: 'github', values: { token: 'bad' } })).toMatchObject({ ok: false, error: { message: expect.stringContaining('401') } })
  expect(credentials.refs.has('DSH_CONNECTORS_GITHUB_TOKEN')).toBe(false)
  expect(await call('setToken', { id: 'github', values: {} })).toMatchObject({ ok: false, error: { code: 'connectors/bad-request' } })

  expect(await call('setToken', { id: 'github', values: { token: '  good \n' } })).toEqual({ ok: true, value: null })
  expect(credentials.refs.get('DSH_CONNECTORS_GITHUB_TOKEN')).toBe('good')
  expect(mcp.registered.get('github')).toMatchObject({ headers: { Authorization: 'Bearer ${credential:DSH_CONNECTORS_GITHUB_TOKEN}' } })
  expect(await row('github')).toMatchObject({ account: 'octocat', via: 'token', state: { kind: 'connecting' } })

  await call('disconnect', { id: 'github' })
  expect(mcp.registered.has('github')).toBe(false)
  expect(credentials.refs.has('DSH_CONNECTORS_GITHUB_TOKEN')).toBe(false)
  expect(credentials.records.has('dsh-connectors/github')).toBe(false)
  expect((await row('github')).state).toEqual({ kind: 'disconnected' })
})

it('connects Azure DevOps through the local server with an encoded PAT', async () => {
  const seen: string[] = []
  const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    seen.push(String(url))
    const auth = new Headers(init?.headers).get('authorization')
    if (auth !== `Basic ${Buffer.from(':pat').toString('base64')}`) return new Response('<html>sign in</html>', { status: 203, headers: { 'content-type': 'text/html' } })
    return Response.json({ authenticatedUser: { providerDisplayName: 'Ada' } })
  }) as unknown as typeof fetch
  const { call, row, credentials, mcp } = setup({ fetch: fetchFn })
  expect(await call('setToken', { id: 'azure-devops', values: { organization: 'contoso', token: 'wrong' } })).toMatchObject({ ok: false, error: { message: expect.stringContaining('refused') } })
  expect(await call('setToken', { id: 'azure-devops', values: { organization: '-x; rm', token: 'pat' } })).toMatchObject({ ok: false })
  expect(await call('setToken', { id: 'azure-devops', values: { organization: 'contoso', token: 'pat' } })).toEqual({ ok: true, value: null })
  expect(seen).toContain('https://dev.azure.com/contoso/_apis/connectionData')
  expect(credentials.refs.get('DSH_CONNECTORS_AZURE_DEVOPS_TOKEN')).toBe(Buffer.from('dsh:pat').toString('base64'))
  expect(mcp.registered.get('azure-devops')).toEqual({
    transport: 'stdio', command: 'npx', args: ['-y', AZURE_DEVOPS_MCP, 'contoso', '--authentication', 'pat'],
    env: { PERSONAL_ACCESS_TOKEN: '${credential:DSH_CONNECTORS_AZURE_DEVOPS_TOKEN}' }, startupTimeoutMs: 180_000,
  })
  expect(await row('azure-devops')).toMatchObject({ account: 'Ada' })
})

it('adds and removes custom connectors, which survive a restart', async () => {
  const { protocol } = fakeProtocol()
  const first = setup({ protocol })
  expect(await first.call('addCustom', { name: 'Notion', url: 'http://evil.example/mcp' })).toMatchObject({ ok: false })
  expect(await first.call('addCustom', { name: 'Notion', url: 'https://mcp.notion.example/mcp' })).toEqual({ ok: true, value: { id: 'notion', auth: 'oauth' } })
  expect(await first.row('notion')).toMatchObject({ custom: true, auth: ['oauth'], description: 'Custom · mcp.notion.example' })
  await signIn(first.call, 'notion')
  expect(first.mcp.registered.get('notion')).toMatchObject({ url: 'https://mcp.notion.example/mcp' })
  await first.dispose()

  const second = setup({ protocol, credentials: first.credentials })
  await flush()
  expect(await second.row('notion')).toMatchObject({ custom: true, registered: true })
  expect(await second.call('removeCustom', { id: 'github' })).toMatchObject({ ok: false })
  await second.call('removeCustom', { id: 'notion' })
  expect((await second.list()).some(item => item.id === 'notion')).toBe(false)
  expect(second.mcp.registered.has('notion')).toBe(false)
  expect(second.credentials.refs.has('DSH_CONNECTORS_NOTION_TOKEN')).toBe(false)
})

it('uses a bearer token for a custom server without client registration', async () => {
  const { protocol } = fakeProtocol({ dcr: false })
  const { call, mcp } = setup({ protocol })
  expect(await call('addCustom', { name: 'Internal', url: 'https://mcp.internal.example/mcp' })).toMatchObject({ ok: true, value: { auth: 'token' } })
  await call('setToken', { id: 'internal', values: { token: 'tok' } })
  expect(mcp.registered.get('internal')).toMatchObject({ headers: { Authorization: 'Bearer ${credential:DSH_CONNECTORS_INTERNAL_TOKEN}' } })
})

it('lets another plugin register a connector and removes it on disposal', async () => {
  const { service, list, mcp } = setup({ credentials: memoryCredentials(new Map([['DSH_CONNECTORS_NOTION_TOKEN', 't']])) })
  const remove = service().register({
    id: 'notion', name: 'Notion', description: 'Pages',
    token: { fields: [{ id: 'token', label: 'API key', secret: true }], verify: async values => ({ credential: values.token ?? '' }) },
    server: ({ credential }) => ({ transport: 'streamable-http', url: 'https://mcp.notion.example/mcp', headers: { Authorization: `Bearer ${credential}` } }),
  })
  await flush()
  expect(mcp.registered.has('notion')).toBe(true)
  expect(() => service().register({ id: 'notion', name: 'x', description: '', token: { fields: [], verify: async () => ({ credential: 'x' }) }, server: () => ({ transport: 'stdio', command: 'x' }) })).toThrow(/already registered/)
  expect(() => service().register({ id: 'Bad_Id', name: 'x', description: '', server: () => ({ transport: 'stdio', command: 'x' }) })).toThrow()
  expect(() => service().register({ id: 'custom-connectors', name: 'x', description: '', token: { fields: [], verify: async () => ({ credential: 'x' }) }, server: () => ({ transport: 'stdio', command: 'x' }) })).toThrow(/reserved/)
  remove()
  expect(mcp.registered.has('notion')).toBe(false)
  expect((await list()).some(item => item.id === 'notion')).toBe(false)
})

it('checks the connector package standard before installing through the plugin manager', async () => {
  const manifests: Record<string, Record<string, unknown>> = {
    good: { keywords: ['dsh-connector'], dsh: { bundle: { patch: './cordis.patch.yml' }, connector: { ids: ['linear'] } } },
    notConnector: { keywords: ['dsh-plugin'], dsh: { bundle: {} } },
  }
  let manifest = manifests.good!
  const fetchFn = vi.fn(async () => Response.json(manifest)) as unknown as typeof fetch
  const installs: unknown[] = []
  const pluginManager: PluginManager = {
    inspect: async spec => ({ status: 'accepted', kind: 'registry', name: spec.replace(/(?<=.)@[^@/]+$/, ''), version: '1.0.0', bundle: true, registry: null }),
    installBundle: async (spec, opts) => {
      installs.push([spec, opts])
      return opts?.gateAcknowledged === 'abc' ? { application: 'applied' } : {
        application: 'failed', error: { code: 'gate-review' },
        gateReport: { digest: 'abc', level: 'review', score: 60, reasons: [{ en: 'Network access' }], findings: [{ severity: 'medium', title: 'fetch call', file: 'lib/index.js' }] },
      }
    },
  }
  const { call } = setup({ fetch: fetchFn, pluginManager })
  expect(await call('capabilities')).toEqual({ ok: true, value: { packages: true } })
  expect(await call('checkPackage', { spec: '@acme/dsh-connector-linear' })).toEqual({ ok: true, value: { ok: true, name: '@acme/dsh-connector-linear', version: '1.0.0', connectorIds: ['linear'] } })
  expect(fetchFn).toHaveBeenCalledWith('https://registry.npmjs.org/@acme%2fdsh-connector-linear/1.0.0', expect.anything())

  const review = await call('installPackage', { name: '@acme/dsh-connector-linear', version: '1.0.0' })
  expect(review.value).toEqual({ status: 'review', gate: { digest: 'abc', level: 'review', score: 60, reasons: ['Network access'], findings: ['medium: fetch call (lib/index.js)'] } })
  expect(await call('installPackage', { name: '@acme/dsh-connector-linear', version: '1.0.0', gateAcknowledged: 'abc' })).toEqual({ ok: true, value: { status: 'installed' } })
  expect(installs[0]).toEqual(['@acme/dsh-connector-linear@1.0.0', { enabled: true, saveExact: true, expected: { name: '@acme/dsh-connector-linear', version: '1.0.0' } }])

  manifest = manifests.notConnector!
  expect((await call('checkPackage', { spec: 'some-plugin' })).value).toMatchObject({ ok: false, reason: expect.stringContaining('dsh-connector') })
  expect(await call('installPackage', { name: 'some-plugin', version: '1.0.0' })).toMatchObject({ ok: false })
  expect(installs).toHaveLength(2)
})

it('validates the connector package manifest rules', () => {
  const base = { keywords: ['dsh-connector'], dsh: { bundle: {}, connector: { ids: ['a'] } } }
  expect(connectorIds(base)).toEqual(['a'])
  expect(() => connectorIds({ ...base, dsh: { ...base.dsh, client: {} } })).toThrow(/Host only/)
  expect(() => connectorIds({ ...base, dsh: { bundle: {} } })).toThrow(/dsh.connector.ids/)
  expect(() => connectorIds({ ...base, dsh: { bundle: {}, connector: { ids: ['Bad'] } } })).toThrow(/not a valid/)
  expect(() => connectorIds({ keywords: ['dsh-connector'], dsh: { connector: { ids: ['a'] } } })).toThrow(/dsh.bundle/)
})

it('says when there is no plugin manager', async () => {
  const { call } = setup()
  expect(await call('capabilities')).toEqual({ ok: true, value: { packages: false } })
  expect(await call('checkPackage', { spec: 'x' })).toMatchObject({ ok: false, error: { code: 'connectors/bad-request' } })
})

it('parses the plugin config and helpers', () => {
  expect(parseConfig(undefined)).toEqual({})
  expect(parseConfig({ github: { clientId: 'Iv1', appSlug: 's' } })).toEqual({ github: { clientId: 'Iv1', appSlug: 's' } })
  expect(() => parseConfig({ github: {} })).toThrow(/clientId/)
  expect(tokenRef('azure-devops')).toBe('DSH_CONNECTORS_AZURE_DEVOPS_TOKEN')
  expect(customId('Notion', new Set(['notion']))).toBe('notion-2')
  expect(customId('1Password!', new Set())).toBe('c-1password')
  expect(customId('custom connectors', new Set())).toBe('custom-connectors-2')
  expect(customUrl('http://localhost:3000/mcp')).toBe('http://localhost:3000/mcp')
  expect(() => customUrl('https://user:pw@x.example/mcp')).toThrow()
  expect(stateOf(undefined)).toEqual({ kind: 'disconnected' })
  expect(stateOf({ state: 'reconnecting', attempt: 1, maxAttempts: 5, lastError: 'boom' })).toEqual({ kind: 'connecting', detail: 'boom' })
  expect(stateOf({ state: 'waiting-credentials', lastError: 'x' }).kind).toBe('error')
  expect(cleanError('mcp-client(github): startup: SdkHttpError: Error POSTing to endpoint: bad request\n')).toBe('Error POSTing to endpoint: bad request')
})
