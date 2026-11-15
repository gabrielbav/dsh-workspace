/**
 * Turns a catalog entry and the user's settings into the MCP manager registration that runs it. Pure, so the
 * exact command line of every server is covered by tests.
 */
import { PROXY_PACKAGE, PROXY_VERSION, type CatalogServer, type FieldSpec, type LaunchDelta } from './catalog.ts'
import type { McpServerRegistration } from './dsh.ts'

/** Settings the user keeps for one server. */
export interface ServerSettings {
  readonly enabled: boolean
  readonly values: Readonly<Record<string, string>>
  readonly allowWrite: boolean
  readonly allowSensitive: boolean
  readonly profile: string
  readonly region: string
  readonly extraEnv: string
}

/** Settings shared by every server. */
export interface GlobalSettings {
  readonly profile: string
  readonly region: string
}

export const EMPTY_SERVER: ServerSettings = { enabled: false, values: {}, allowWrite: false, allowSensitive: false, profile: '', region: '', extraEnv: '' }

/** A first start downloads the package and a Python, so it gets a long budget. */
export const LOCAL_STARTUP_MS = 180_000

/** Region used for regional endpoints when none is set. */
export const DEFAULT_REGION = 'us-east-1'

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_-]*$/

/**
 * Credential reference of a secret field, `DSH_AWS_<SERVER>_<FIELD>`. The prefix keeps it from matching an
 * environment variable the store falls back to.
 * @param serverId Catalog server id.
 * @param fieldId Field id.
 * @returns The reference.
 */
export function secretRef(serverId: string, fieldId: string): string {
  return `DSH_AWS_${serverId}_${fieldId}`.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase()
}

/**
 * Parse `KEY=VALUE` lines; blank lines and `#` comments are skipped.
 * @param text Lines from the page.
 * @returns The variables.
 * @throws RangeError on a malformed line.
 */
export function parseExtraEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const equals = line.indexOf('=')
    const key = equals < 0 ? line : line.slice(0, equals).trim()
    if (equals < 0 || !ENV_NAME.test(key)) throw new RangeError(`Extra environment line ${String(index + 1)} must look like NAME=value.`)
    const value = line.slice(equals + 1).trim()
    if (value.includes('${')) throw new RangeError(`Extra environment line ${String(index + 1)} must not contain "\${".`)
    env[key] = value
  }
  return env
}

/** The profile and region a server runs with: its own override, else the global setting. */
export function effectiveAws(settings: ServerSettings, global: GlobalSettings): GlobalSettings {
  return { profile: settings.profile || global.profile, region: settings.region || global.region }
}

const filled = (field: FieldSpec, settings: ServerSettings, secrets: ReadonlySet<string>): boolean =>
  field.kind === 'secret' ? secrets.has(field.id) : (settings.values[field.id] ?? '') !== ''

/**
 * What the server still needs before it can start.
 * @param server Catalog entry.
 * @param settings The server's settings.
 * @param global Global settings.
 * @param secrets Ids of secret fields with a stored value.
 * @returns Labels of the missing settings; empty when it can start.
 */
export function missingSettings(server: CatalogServer, settings: ServerSettings, global: GlobalSettings, secrets: ReadonlySet<string>): string[] {
  const fields = server.fields ?? []
  const missing = fields.filter(field => field.required === true && !filled(field, settings, secrets)).map(field => field.label)
  if (server.requireAny !== undefined && !server.requireAny.some(id => {
    const field = fields.find(item => item.id === id)
    return field !== undefined && filled(field, settings, secrets)
  })) {
    missing.push(server.requireAny.map(id => fields.find(item => item.id === id)?.label ?? id).join(' or '))
  }
  if (server.regionArg !== undefined && effectiveAws(settings, global).region === '') missing.push('AWS region')
  return missing
}

/**
 * Build the registration.
 * @param server Catalog entry.
 * @param settings The server's settings.
 * @param global Global settings.
 * @param secrets Ids of secret fields with a stored value.
 * @param uvx Absolute path of uvx, for local and proxied servers.
 * @returns The MCP manager entry.
 */
export function registration(server: CatalogServer, settings: ServerSettings, global: GlobalSettings, secrets: ReadonlySet<string>, uvx: string): McpServerRegistration {
  const { launch } = server
  if (launch.kind === 'remote') return { transport: 'streamable-http', url: launch.url }

  const aws = effectiveAws(settings, global)
  const args: string[] = []
  const env: Record<string, string> = {}
  const apply = (delta: LaunchDelta | undefined): void => {
    if (delta === undefined) return
    args.push(...delta.args ?? [])
    Object.assign(env, delta.env)
  }

  if (launch.kind === 'proxy') {
    const region = aws.region || DEFAULT_REGION
    args.push('--from', `${PROXY_PACKAGE}==${PROXY_VERSION}`, PROXY_PACKAGE, launch.url.replace('{region}', region), ...launch.args ?? [])
    if (launch.service !== undefined) args.push('--service', launch.service)
    if (aws.profile !== '') args.push('--profile', aws.profile)
    args.push('--region', launch.signingRegion ?? region)
  } else {
    if (launch.python !== undefined) args.push('--python', launch.python)
    args.push('--from', `${launch.package}==${launch.version}`, ...(launch.with ?? []).flatMap(item => ['--with', item]), launch.bin ?? launch.package, ...launch.args ?? [])
    env.FASTMCP_LOG_LEVEL = 'ERROR'
    if (server.aws) {
      if (aws.profile !== '') env.AWS_PROFILE = aws.profile
      if (aws.region !== '') { env.AWS_REGION = aws.region; env.AWS_DEFAULT_REGION = aws.region }
    }
    if (server.regionArg !== undefined && aws.region !== '') args.push(server.regionArg, aws.region)
  }
  Object.assign(env, server.env)

  for (const field of server.fields ?? []) {
    if (field.kind === 'secret') {
      if (secrets.has(field.id) && 'env' in field.target) env[field.target.env] = `\${credential:${secretRef(server.id, field.id)}}`
      continue
    }
    const value = settings.values[field.id] ?? ''
    if (value === '' || (field.kind === 'boolean' && value !== 'true')) continue
    if ('env' in field.target) env[field.target.env] = value
    else if (field.kind === 'boolean') args.push(field.target.arg)
    else args.push(field.target.arg, value)
  }

  apply(settings.allowWrite ? server.write : server.readOnly)
  if (settings.allowSensitive) apply(server.sensitive)
  // The AWS MCP Server reads its operating region from request metadata; `--metadata` takes the rest of the line.
  if (launch.kind === 'proxy' && launch.regionMetadata === true) args.push('--metadata', `AWS_REGION=${aws.region || DEFAULT_REGION}`)
  Object.assign(env, parseExtraEnv(settings.extraEnv))

  return { transport: 'stdio', command: uvx, args, env, startupTimeoutMs: LOCAL_STARTUP_MS }
}
