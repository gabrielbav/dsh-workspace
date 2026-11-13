/**
 * Connector packages: an npm package that adds connectors through the `connectors` service. Before anything installs,
 * the registry manifest must follow the connector package standard (see README): the `dsh-connector` keyword, a
 * `dsh.connector.ids` list, a `dsh.bundle` and no browser half. That filters out packages that are not connectors; it
 * is not a security check, because the code still runs in the Host. The install itself goes through the harness
 * plugin manager, so registered install gates (such as airlock) scan the package first.
 */
import type { PackageCheck, PackageInstall } from '../shared.ts'

/** Connector ids, as in the service. */
const ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/

/** npm package names (scoped or not), lowercase as the registry requires today. */
const NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/

/** `pluginManager` members this module uses (`@deepseek-ai/dsh-plugin-manager`). */
export interface PluginManager {
  inspect(spec: string, options?: object, signal?: AbortSignal): Promise<
    | { status: 'accepted'; kind: 'registry' | 'path' | 'git' | 'tarball'; name?: string; version?: string; description?: string; bundle: boolean | null; registry: string | null }
    | { status: 'refused'; problem: string; reason: string }
  >
  installBundle(spec: string, options?: {
    enabled?: boolean
    saveExact?: boolean
    expected?: { readonly name: string; readonly version: string }
    gateAcknowledged?: string
  }): Promise<{
    application: 'applied' | 'restart-required' | 'overridden' | 'failed' | 'cancelled'
    error?: { code: string; diagnostic?: string }
    gateReport?: {
      digest: string
      level: 'pass' | 'review' | 'block'
      score?: number
      reasons: readonly { readonly en: string }[]
      findings: readonly { readonly severity: string; readonly title: string; readonly file?: string }[]
    }
  }>
}

/** Registry used when the plugin manager reports pnpm's own default. */
const NPM_REGISTRY = 'https://registry.npmjs.org/'

/**
 * Check that a manifest follows the connector package standard.
 * @param manifest The published `package.json` of one version.
 * @returns The connector ids it declares.
 * @throws A message naming the rule the package breaks.
 */
export function connectorIds(manifest: Record<string, unknown>): string[] {
  const keywords = Array.isArray(manifest.keywords) ? manifest.keywords : []
  if (!keywords.includes('dsh-connector')) throw new Error('It is not a connector package: its package.json lacks the "dsh-connector" keyword.')
  const dsh = typeof manifest.dsh === 'object' && manifest.dsh !== null ? manifest.dsh as Record<string, unknown> : {}
  if (dsh.bundle === undefined) throw new Error('It is not a DSH plugin: its package.json has no "dsh.bundle".')
  if (dsh.client !== undefined) throw new Error('Connector packages run on the Host only; this one also ships browser code ("dsh.client").')
  const connector = typeof dsh.connector === 'object' && dsh.connector !== null ? dsh.connector as Record<string, unknown> : undefined
  const ids = connector?.ids
  if (!Array.isArray(ids) || ids.length === 0) throw new Error('Its package.json does not declare the connectors it adds in "dsh.connector.ids".')
  for (const id of ids) {
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) throw new Error(`"${String(id)}" in dsh.connector.ids is not a valid connector id.`)
  }
  return ids as string[]
}

/**
 * Look a connector package up in the registry, without installing it.
 * @param manager The plugin manager.
 * @param spec `name` or `name@version` from the registry.
 * @param fetchFn Fetch implementation.
 * @returns What would install, or why it would not.
 */
export async function checkPackage(manager: PluginManager, spec: string, fetchFn: typeof fetch): Promise<PackageCheck> {
  const trimmed = spec.trim()
  const at = trimmed.lastIndexOf('@')
  const name = at > 0 ? trimmed.slice(0, at) : trimmed
  if (!NAME_PATTERN.test(name)) return { ok: false, reason: 'Enter an npm package name, for example @acme/dsh-connector-linear.' }
  const inspected = await manager.inspect(trimmed)
  if (inspected.status === 'refused') return { ok: false, reason: inspected.reason }
  if (inspected.kind !== 'registry' || inspected.name === undefined || inspected.version === undefined) {
    return { ok: false, reason: 'Only packages from an npm registry can be added here; install other sources from the Plugins page.' }
  }
  const registry = (inspected.registry ?? NPM_REGISTRY).replace(/\/?$/, '/')
  const response = await fetchFn(`${registry}${inspected.name.replace('/', '%2f')}/${encodeURIComponent(inspected.version)}`, { headers: { Accept: 'application/json' } })
  if (!response.ok) return { ok: false, reason: `The registry answered ${response.status} for ${inspected.name}@${inspected.version}.` }
  let ids: string[]
  try { ids = connectorIds(await response.json() as Record<string, unknown>) }
  catch (error) { return { ok: false, reason: error instanceof Error ? error.message : String(error) } }
  return {
    ok: true, name: inspected.name, version: inspected.version, connectorIds: ids,
    ...inspected.description === undefined ? {} : { description: inspected.description },
  }
}

/**
 * Install a checked connector package through the plugin manager.
 * @param manager The plugin manager.
 * @param name Package name from {@link checkPackage}.
 * @param version Exact version from {@link checkPackage}.
 * @param gateAcknowledged Digest of an install gate review the user accepted.
 * @returns The outcome, including any gate review to show.
 */
export async function installPackage(manager: PluginManager, name: string, version: string, gateAcknowledged?: string): Promise<PackageInstall> {
  const result = await manager.installBundle(`${name}@${version}`, {
    enabled: true, saveExact: true, expected: { name, version },
    ...gateAcknowledged === undefined ? {} : { gateAcknowledged },
  })
  const report = result.gateReport
  const gate = report === undefined || report.level === 'pass' ? undefined : {
    digest: report.digest,
    level: report.level,
    ...report.score === undefined ? {} : { score: report.score },
    reasons: report.reasons.map(reason => reason.en),
    findings: report.findings.slice(0, 10).map(finding => `${finding.severity}: ${finding.title}${finding.file === undefined ? '' : ` (${finding.file})`}`),
  }
  switch (result.application) {
    case 'applied': return { status: 'installed', ...gate === undefined ? {} : { gate } }
    case 'restart-required': return { status: 'restart-required', ...gate === undefined ? {} : { gate } }
    default:
      if (result.error?.code === 'gate-review' && gate !== undefined) return { status: 'review', gate }
      if (result.error?.code === 'gate-blocked' && gate !== undefined) return { status: 'blocked', gate }
      return { status: 'failed', reason: result.error?.diagnostic ?? result.error?.code ?? `the installation ended as ${result.application}` }
  }
}
