import { afterEach, describe, expect, it } from 'vitest'
import { GROUPS, SERVER_BY_ID, SERVERS } from '../src/host/catalog.ts'
import { awsProfiles, REGION } from '../src/host/environment.ts'
import { mount, stateOf } from '../src/host/index.ts'
import { EMPTY_SERVER, missingSettings, parseExtraEnv, registration, secretRef, type ServerSettings } from '../src/host/launch.ts'
import { SETTINGS_RECORD } from '../src/host/store.ts'
import type { CredentialRecord, Credentials, FetchRoute, HostContext, McpServerRegistration, McpServerView } from '../src/host/dsh.ts'
import type { Overview } from '../src/shared.ts'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const UVX = '/usr/local/bin/uvx'
const NO_GLOBAL = { profile: '', region: '' }
const server = (id: string) => {
  const found = SERVER_BY_ID.get(id)
  if (found === undefined) throw new Error(`no ${id}`)
  return found
}
const settings = (patch: Partial<ServerSettings> = {}): ServerSettings => ({ ...EMPTY_SERVER, enabled: true, ...patch })
const stdio = (entry: McpServerRegistration) => {
  if (entry.transport !== 'stdio') throw new Error('expected stdio')
  return { args: [...entry.args ?? []], env: { ...entry.env }, command: entry.command }
}

describe('catalog', () => {
  it('has unique ids that are valid MCP server names', () => {
    const ids = SERVERS.map(item => item.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(id).toMatch(/^[a-z][a-z0-9-]{0,31}$/)
  })

  it('puts every server in a known group and leaves no group empty', () => {
    const groups = new Set(GROUPS.map(group => group.id))
    for (const item of SERVERS) expect(groups.has(item.group), item.id).toBe(true)
    for (const group of GROUPS) expect(SERVERS.some(item => item.group === group.id), group.id).toBe(true)
  })

  it('leaves out deprecated and superseded servers', () => {
    const packages = SERVERS.map(item => item.launch.kind === 'uvx' ? item.launch.package : '')
    for (const gone of ['aws-api', 'ccapi', 'iam', 'amazon-kendra-index', 'amazon-qbusiness-anonymous', 'frontend', 'aws-diagram', 'nova-canvas', 'core', 'git-repo-research']) {
      expect(packages).not.toContain(`awslabs.${gone}-mcp-server`)
    }
  })

  it('pins exact versions', () => {
    for (const item of SERVERS) if (item.launch.kind === 'uvx') expect(item.launch.version, item.id).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it('keeps fields consistent', () => {
    for (const item of SERVERS) {
      const fields = item.fields ?? []
      expect(new Set(fields.map(field => field.id)).size, item.id).toBe(fields.length)
      for (const id of item.requireAny ?? []) expect(fields.some(field => field.id === id), `${item.id}.${id}`).toBe(true)
      for (const field of fields) {
        if (field.kind === 'secret') expect('env' in field.target, `${item.id}.${field.id}`).toBe(true)
        if (field.kind === 'select') expect(field.options?.length, `${item.id}.${field.id}`).toBeGreaterThan(0)
      }
    }
  })
})

describe('registration', () => {
  it('connects the Knowledge server directly', () => {
    expect(registration(server('aws-knowledge'), settings(), NO_GLOBAL, new Set(), UVX)).toEqual({ transport: 'streamable-http', url: 'https://knowledge-mcp.global.api.aws' })
  })

  it('runs a pinned package with uvx and the global profile and region', () => {
    const { command, args, env } = stdio(registration(server('aws-iac'), settings(), { profile: 'dev', region: 'eu-west-1' }, new Set(), UVX))
    expect(command).toBe(UVX)
    expect(args).toEqual(['--from', 'awslabs.aws-iac-mcp-server==1.0.26', 'awslabs.aws-iac-mcp-server'])
    expect(env).toMatchObject({ AWS_PROFILE: 'dev', AWS_REGION: 'eu-west-1', AWS_DEFAULT_REGION: 'eu-west-1', FASTMCP_LOG_LEVEL: 'ERROR' })
  })

  it('lets a server override the profile and region', () => {
    const { env } = stdio(registration(server('aws-iac'), settings({ profile: 'prod', region: 'us-west-2' }), { profile: 'dev', region: 'eu-west-1' }, new Set(), UVX))
    expect(env).toMatchObject({ AWS_PROFILE: 'prod', AWS_REGION: 'us-west-2' })
  })

  it('does not pass AWS settings to servers that do not use them', () => {
    const { env } = stdio(registration(server('aws-docs'), settings(), { profile: 'dev', region: 'eu-west-1' }, new Set(), UVX))
    expect(env.AWS_PROFILE).toBeUndefined()
  })

  it('is read-only until writes and sensitive data are allowed', () => {
    expect(stdio(registration(server('aws-eks'), settings(), NO_GLOBAL, new Set(), UVX)).args).not.toContain('--allow-write')
    const open = stdio(registration(server('aws-eks'), settings({ allowWrite: true, allowSensitive: true }), NO_GLOBAL, new Set(), UVX)).args
    expect(open).toEqual(expect.arrayContaining(['--allow-write', '--allow-sensitive-data-access']))
    expect(stdio(registration(server('aws-ecs'), settings(), NO_GLOBAL, new Set(), UVX)).env.ALLOW_WRITE).toBe('false')
    expect(stdio(registration(server('aws-ecs'), settings({ allowWrite: true }), NO_GLOBAL, new Set(), UVX)).env.ALLOW_WRITE).toBe('true')
    expect(stdio(registration(server('aws-valkey'), settings({ values: { host: 'h' } }), NO_GLOBAL, new Set(), UVX)).args).toContain('--readonly')
    expect(stdio(registration(server('aws-valkey'), settings({ values: { host: 'h' }, allowWrite: true }), NO_GLOBAL, new Set(), UVX)).args).not.toContain('--readonly')
  })

  it('runs ECS through its console script', () => {
    expect(stdio(registration(server('aws-ecs'), settings(), NO_GLOBAL, new Set(), UVX)).args.slice(0, 5)).toEqual(['--from', 'awslabs.ecs-mcp-server==0.1.38', '--with', 'fastmcp<4', 'ecs-mcp-server'])
  })

  it('adds the dependency and Python pins some releases need', () => {
    expect(stdio(registration(server('aws-keyspaces'), settings(), NO_GLOBAL, new Set(), UVX)).args.slice(0, 4)).toEqual(['--python', '3.11', '--from', 'awslabs.amazon-keyspaces-mcp-server==0.0.19'])
    expect(stdio(registration(server('aws-healthlake'), settings(), NO_GLOBAL, new Set(), UVX)).args).toEqual(expect.arrayContaining(['--with', 'mcp<2']))
    expect(stdio(registration(server('aws-qindex'), settings(), NO_GLOBAL, new Set(), UVX)).args).toEqual(expect.arrayContaining(['--with', 'mypy-boto3-qbusiness']))
  })

  it('proxies the AWS MCP Server read-only with its region as metadata', () => {
    const { args } = stdio(registration(server('aws-mcp'), settings(), { profile: 'dev', region: '' }, new Set(), UVX))
    expect(args).toEqual([
      '--from', 'mcp-proxy-for-aws-cli==1.8.0', 'mcp-proxy-for-aws-cli', 'https://aws-mcp.us-east-1.api.aws/mcp', '--skip-auth',
      '--profile', 'dev', '--region', 'us-east-1', '--read-only', '--metadata', 'AWS_REGION=us-east-1',
    ])
    expect(stdio(registration(server('aws-mcp'), settings({ allowWrite: true }), NO_GLOBAL, new Set(), UVX)).args).not.toContain('--read-only')
    const regional = stdio(registration(server('aws-mcp'), settings(), { profile: '', region: 'eu-west-1' }, new Set(), UVX)).args
    expect(regional).toEqual(expect.arrayContaining(['--region', 'us-east-1', '--metadata', 'AWS_REGION=eu-west-1']))
    expect(regional).not.toContain('eu-west-1')
  })

  it('puts the region into regional proxy endpoints', () => {
    const { args } = stdio(registration(server('aws-spark-upgrade'), settings(), { profile: '', region: 'eu-west-1' }, new Set(), UVX))
    expect(args).toContain('https://sagemaker-unified-studio-mcp.eu-west-1.api.aws/spark-upgrade/mcp')
    expect(args).toEqual(expect.arrayContaining(['--service', 'sagemaker-unified-studio-mcp']))
  })

  it('maps form values to arguments and secrets to credential templates', () => {
    const dsql = stdio(registration(server('aws-dsql'), settings({ values: { endpoint: 'abc.dsql.us-east-1.on.aws', user: 'admin' } }), { profile: '', region: 'us-east-1' }, new Set(), UVX))
    expect(dsql.args).toEqual(expect.arrayContaining(['--cluster_endpoint', 'abc.dsql.us-east-1.on.aws', '--database_user', 'admin', '--region', 'us-east-1']))
    const docdb = stdio(registration(server('aws-documentdb'), settings(), NO_GLOBAL, new Set(['connection']), UVX))
    expect(docdb.env.DOCUMENTDB_CONNECTION_STRING).toBe(`\${credential:${secretRef('aws-documentdb', 'connection')}}`)
    expect(secretRef('aws-documentdb', 'connection')).toBe('DSH_AWS_AWS_DOCUMENTDB_CONNECTION')
    const kb = stdio(registration(server('aws-bedrock-kb'), settings({ values: { rerank: 'true' } }), NO_GLOBAL, new Set(), UVX))
    expect(kb.env.BEDROCK_KB_RERANKING_ENABLED).toBe('true')
  })

  it('adds extra environment lines last', () => {
    const { env } = stdio(registration(server('aws-iac'), settings({ extraEnv: '# comment\nFASTMCP_LOG_LEVEL=DEBUG\n\nDDB-MCP-READONLY=true' }), NO_GLOBAL, new Set(), UVX))
    expect(env).toMatchObject({ FASTMCP_LOG_LEVEL: 'DEBUG', 'DDB-MCP-READONLY': 'true' })
  })

  it('refuses malformed extra environment lines', () => {
    expect(() => parseExtraEnv('no equals sign')).toThrow(RangeError)
    expect(() => parseExtraEnv('A=${credential:OTHER}')).toThrow(RangeError)
  })
})

describe('missingSettings', () => {
  it('lists required fields, either-or fields and a required region', () => {
    expect(missingSettings(server('aws-dsql'), settings(), NO_GLOBAL, new Set())).toEqual(['Cluster endpoint', 'Database user', 'AWS region'])
    expect(missingSettings(server('aws-lambda-tool'), settings(), NO_GLOBAL, new Set())).toEqual(['Function name prefix or Function names or Tag key'])
    expect(missingSettings(server('aws-lambda-tool'), settings({ values: { list: 'a' } }), NO_GLOBAL, new Set())).toEqual([])
    expect(missingSettings(server('aws-documentdb'), settings(), NO_GLOBAL, new Set(['connection']))).toEqual([])
    expect(missingSettings(server('aws-iac'), settings(), NO_GLOBAL, new Set())).toEqual([])
  })
})

describe('environment', () => {
  it('reads profile names only', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-aws-'))
    await writeFile(join(dir, 'config'), '[default]\nregion = us-east-1\n[profile dev]\nsso_session = x\n[sso-session x]\n')
    await writeFile(join(dir, 'credentials'), '[ci]\naws_access_key_id = AKIA\naws_secret_access_key = secret\n')
    expect(await awsProfiles({ AWS_CONFIG_FILE: join(dir, 'config'), AWS_SHARED_CREDENTIALS_FILE: join(dir, 'credentials') }, dir)).toEqual(['ci', 'default', 'dev'])
  })

  it('accepts region names', () => {
    expect(REGION.test('us-gov-west-1')).toBe(true)
    expect(REGION.test('--region')).toBe(false)
  })

  it('maps MCP manager statuses', () => {
    expect(stateOf({ state: 'connected', toolCount: 3 })).toEqual({ kind: 'connected', toolCount: 3 })
    expect(stateOf({ state: 'failed', reason: 'exit', lastError: ' spawn\n uvx ENOENT ' })).toEqual({ kind: 'error', message: 'spawn uvx ENOENT' })
  })
})

// ── The mounted plugin ──

const disposers: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const dispose of disposers.splice(0).reverse()) await dispose() })

function memoryCredentials(refs = new Map<string, string>(), records = new Map<string, CredentialRecord>()): Credentials & { refs: Map<string, string>; records: Map<string, CredentialRecord> } {
  return {
    refs, records,
    describe: async ref => ({ configured: refs.has(ref), writable: true }),
    set: async (ref, value) => { refs.set(ref, value) },
    unset: async (ref) => { refs.delete(ref) },
    readRecord: async key => records.get(key),
    modifyRecord: async (key, mutate) => { const next = await mutate(records.get(key)); if (next !== undefined) records.set(key, next); return next },
  }
}

function fakeManager() {
  const registered = new Map<string, McpServerRegistration>()
  const restarts: string[] = []
  return {
    registered, restarts,
    register: (name: string, entry: McpServerRegistration) => {
      if (registered.has(name)) throw new Error(`server "${name}" is already registered`)
      registered.set(name, entry)
      return () => { registered.delete(name) }
    },
    list: (): McpServerView[] => [...registered.keys()].map(name => ({ name, configured: false, status: { state: 'connected', toolCount: 2 } })),
    restart: async (name: string) => { restarts.push(name) },
  }
}

async function setup(options: { uvx?: string | undefined; records?: Map<string, CredentialRecord> } = {}) {
  const credentials = memoryCredentials(new Map(), options.records)
  const mcp = fakeManager()
  const routes = new Map<string, FetchRoute>()
  const cleanups: (() => void | Promise<void>)[] = []
  const warnings: unknown[][] = []
  const ctx: HostContext = {
    mcpManager: mcp,
    credentials,
    logger: { warn: (...args) => { warnings.push(args) }, info: () => {} },
    effect: (execute) => { cleanups.push(execute()) },
    inject: (_names, callback) => {
      callback({ ...ctx, connection: { fetch: { register: (route) => { routes.set(route.path, route); return () => { routes.delete(route.path) } } } } })
    },
  }
  const uvx = 'uvx' in options ? options.uvx : UVX
  await mount(ctx, { findUvx: async () => uvx, uvxVersion: async () => '0.9.25', profiles: async () => ['default', 'dev'] })
  disposers.push(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
  const call = async (endpoint: string, payload: unknown) => {
    const route = routes.get(`/api/awsMcp.${endpoint}`)
    if (route === undefined) throw new Error(`no route ${endpoint}`)
    const response = await route.fetch(new Request('http://dsh/api', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: '1', method: `awsMcp.${endpoint}`, payload }),
    }))
    return (await response.json() as { result: { ok: true; value: unknown } | { ok: false; error: { message: string } } }).result
  }
  const value = async <T>(endpoint: string, payload: unknown): Promise<T> => {
    const result = await call(endpoint, payload)
    if (!result.ok) throw new Error(result.error.message)
    return result.value as T
  }
  return { credentials, mcp, call, value, warnings, cleanups }
}

describe('plugin', () => {
  it('registers servers as they are switched on, by group or one by one', async () => {
    const { mcp, value } = await setup()
    await value('setEnabled', { ids: ['aws-knowledge', 'aws-docs'], enabled: true })
    expect([...mcp.registered.keys()].sort()).toEqual(['aws-docs', 'aws-knowledge'])
    await value('setEnabled', { ids: ['aws-docs'], enabled: false })
    expect([...mcp.registered.keys()]).toEqual(['aws-knowledge'])
    const overview = await value<Overview>('list', {})
    expect(overview.servers.find(item => item.id === 'aws-knowledge')?.state).toEqual({ kind: 'connected', toolCount: 2 })
    expect(overview.servers.find(item => item.id === 'aws-docs')?.state).toEqual({ kind: 'off' })
    expect(overview.profiles).toEqual(['default', 'dev'])
    expect(overview.uv).toEqual({ found: true, path: UVX, version: '0.9.25' })
  })

  it('restores enabled servers on start', async () => {
    const records = new Map<string, CredentialRecord>([[SETTINGS_RECORD, { kind: 'grant', payload: { profile: 'dev', region: 'eu-west-1', servers: { 'aws-iac': { enabled: true } } } }]])
    const { mcp } = await setup({ records })
    expect(stdio(mcp.registered.get('aws-iac') ?? { transport: 'streamable-http', url: '' }).env).toMatchObject({ AWS_PROFILE: 'dev', AWS_REGION: 'eu-west-1' })
  })

  it('waits for required settings, then stores secrets in the credential store', async () => {
    const { mcp, credentials, value } = await setup()
    await value('setEnabled', { ids: ['aws-documentdb'], enabled: true })
    expect(mcp.registered.has('aws-documentdb')).toBe(false)
    let overview = await value<Overview>('list', {})
    expect(overview.servers.find(item => item.id === 'aws-documentdb')?.state).toEqual({ kind: 'needs-setup', missing: ['Connection string'] })

    await value('configure', { id: 'aws-documentdb', values: {}, secrets: { connection: 'mongodb://u:p@host/' }, allowWrite: false, allowSensitive: false, profile: '', region: '', extraEnv: '' })
    const ref = secretRef('aws-documentdb', 'connection')
    expect(credentials.refs.get(ref)).toBe('mongodb://u:p@host/')
    expect(stdio(mcp.registered.get('aws-documentdb') ?? { transport: 'streamable-http', url: '' }).env.DOCUMENTDB_CONNECTION_STRING).toBe(`\${credential:${ref}}`)
    overview = await value<Overview>('list', {})
    const view = overview.servers.find(item => item.id === 'aws-documentdb')
    expect(view?.secretsSet).toEqual(['connection'])
    expect(JSON.stringify(overview)).not.toContain('mongodb://u:p')

    const running = mcp.registered.get('aws-documentdb')
    await value('configure', { id: 'aws-documentdb', values: {}, secrets: { connection: 'mongodb://u:other@host/' }, allowWrite: false, allowSensitive: false, profile: '', region: '', extraEnv: '' })
    expect(mcp.registered.get('aws-documentdb')).toBe(running)
    expect(mcp.restarts).toEqual(['aws-documentdb'])

    await value('configure', { id: 'aws-documentdb', values: {}, secrets: { connection: '' }, allowWrite: false, allowSensitive: false, profile: '', region: '', extraEnv: '' })
    expect(credentials.refs.has(ref)).toBe(false)
    expect(mcp.registered.has('aws-documentdb')).toBe(false)
  })

  it('keeps a running server when nothing about it changed, and replaces it when its settings do', async () => {
    const { mcp, value } = await setup()
    await value('setEnabled', { ids: ['aws-iac'], enabled: true })
    const first = mcp.registered.get('aws-iac')
    await value('setEnabled', { ids: ['aws-knowledge'], enabled: true })
    expect(mcp.registered.get('aws-iac')).toBe(first)
    await value('setGlobal', { profile: 'dev', region: 'us-west-2' })
    expect(mcp.registered.get('aws-iac')).not.toBe(first)
  })

  it('runs remote servers but holds local ones while uvx is missing', async () => {
    const { mcp, value } = await setup({ uvx: undefined })
    await value('setEnabled', { ids: ['aws-knowledge', 'aws-iac'], enabled: true })
    expect([...mcp.registered.keys()]).toEqual(['aws-knowledge'])
    const overview = await value<Overview>('list', {})
    expect(overview.uv.found).toBe(false)
    expect(overview.servers.find(item => item.id === 'aws-iac')?.state).toEqual({ kind: 'needs-uv' })
  })

  it('refuses values that could be read as flags, unknown fields and impossible permissions', async () => {
    const { call } = await setup()
    const base = { values: {}, secrets: {}, allowWrite: false, allowSensitive: false, profile: '', region: '', extraEnv: '' }
    expect(await call('setGlobal', { profile: '--endpoint-url', region: '' })).toMatchObject({ ok: false })
    expect(await call('setGlobal', { profile: 'dev', region: 'mars-1' })).toMatchObject({ ok: false })
    expect(await call('configure', { ...base, id: 'aws-dsql', values: { endpoint: '--allow-writes' } })).toMatchObject({ ok: false })
    expect(await call('configure', { ...base, id: 'aws-dsql', values: { nope: 'x' } })).toMatchObject({ ok: false })
    expect(await call('configure', { ...base, id: 'aws-iac', allowWrite: true })).toMatchObject({ ok: false })
    expect(await call('configure', { ...base, id: 'aws-docs', values: { partition: 'aws-mars' } })).toMatchObject({ ok: false })
    expect(await call('setEnabled', { ids: ['not-a-server'], enabled: true })).toMatchObject({ ok: false })
  })

  it('restarts a running server and removes every server on unload', async () => {
    const { mcp, value, cleanups } = await setup()
    await value('setEnabled', { ids: ['aws-knowledge'], enabled: true })
    await value('restart', { id: 'aws-knowledge' })
    expect(mcp.restarts).toEqual(['aws-knowledge'])
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
    expect(mcp.registered.size).toBe(0)
  })
})
