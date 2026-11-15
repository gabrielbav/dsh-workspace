/**
 * Custom connectors: a name and a remote MCP URL the user adds from the Settings page. They are data, not code, and
 * live in one credential record so they survive restarts. Sign-in is OAuth when the server's authorization server
 * supports Dynamic Client Registration, otherwise a bearer token.
 */
import type { ConnectorDefinition } from './api.ts'
import type { Credentials } from './dsh.ts'
import { SDK_PROTOCOL, type OAuthProtocol } from './oauth.ts'

/** Record holding every custom connector. Its id is reserved, so no connector can take it. */
export const CUSTOM_RECORD = 'dsh-connectors/custom-connectors'

/** Connector ids that custom connectors may not take. */
const RESERVED = new Set(['custom-connectors'])

/** One stored custom connector. */
export interface CustomConnector {
  readonly id: string
  readonly name: string
  readonly url: string
  readonly auth: 'oauth' | 'token'
}

/**
 * Check a custom connector URL.
 * @param raw What the user typed.
 * @returns The normalized URL.
 * @throws When it is not https, or http to this machine.
 */
export function customUrl(raw: string): string {
  let url: URL
  try { url = new URL(raw.trim()) }
  catch (error) { void error; throw new RangeError('The URL is not valid.') }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw new RangeError('The URL must start with https:// (http:// only for this computer).')
  if (url.username !== '' || url.password !== '') throw new RangeError('Put credentials in the token, not in the URL.')
  return url.href
}

/**
 * Derive a connector id from a name.
 * @param name Display name.
 * @param taken Ids already in use.
 * @returns A free id matching the connector id pattern.
 */
export function customId(name: string, taken: ReadonlySet<string>): string {
  const base = name.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/^(\d)/, 'c-$1').slice(0, 28) || 'custom'
  for (let n = 1; ; n++) {
    const id = n === 1 ? base : `${base.slice(0, 28)}-${n}`
    if (!taken.has(id) && !RESERVED.has(id)) return id
  }
}

/**
 * Learn how a server signs in.
 * @param url MCP endpoint.
 * @param protocol SDK functions.
 * @returns `oauth` when its authorization server registers clients dynamically, otherwise `token`.
 */
export async function detectAuth(url: string, protocol: OAuthProtocol = SDK_PROTOCOL): Promise<'oauth' | 'token'> {
  try {
    const info = await protocol.discoverOAuthServerInfo(url)
    return info.authorizationServerMetadata?.registration_endpoint === undefined ? 'token' : 'oauth'
  } catch (error) {
    void error
    return 'token'
  }
}

/**
 * Turn a stored custom connector into a definition.
 * @param custom The stored connector.
 * @returns The definition.
 */
export function customDefinition(custom: CustomConnector): ConnectorDefinition {
  const host = new URL(custom.url).host
  return {
    id: custom.id,
    name: custom.name,
    description: `Custom · ${host}`,
    ...custom.auth === 'oauth'
      ? { oauth: { resourceUrl: custom.url } }
      : {
          token: {
            fields: [{ id: 'token', label: 'Bearer token', secret: true }],
            verify: async values => ({ credential: values.token ?? '' }),
          },
        },
    server: ({ credential }) => ({ transport: 'streamable-http', url: custom.url, headers: { Authorization: `Bearer ${credential}` } }),
  }
}

/**
 * Read the stored custom connectors.
 * @param credentials Credential store.
 * @returns The connectors; malformed entries are skipped.
 */
export async function readCustom(credentials: Credentials): Promise<CustomConnector[]> {
  const record = await credentials.readRecord(CUSTOM_RECORD)
  const list = record?.kind === 'grant' ? (record.payload as { connectors?: unknown }).connectors : undefined
  if (!Array.isArray(list)) return []
  return list.filter((item): item is CustomConnector => typeof item === 'object' && item !== null
    && typeof item.id === 'string' && typeof item.name === 'string' && typeof item.url === 'string'
    && (item.auth === 'oauth' || item.auth === 'token'))
}

/**
 * Replace the stored custom connectors.
 * @param credentials Credential store.
 * @param connectors The new list.
 */
export async function writeCustom(credentials: Credentials, connectors: readonly CustomConnector[]): Promise<void> {
  await credentials.modifyRecord(CUSTOM_RECORD, () => Promise.resolve({ kind: 'grant', payload: { connectors } }))
}
