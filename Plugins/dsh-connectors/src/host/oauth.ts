/**
 * OAuth 2.1 sign-in for MCP servers that support discovery and Dynamic Client Registration (RFC 9728, RFC 8414,
 * RFC 7591), with PKCE S256 and a one-shot loopback redirect on 127.0.0.1 (RFC 8252). The protocol steps come from
 * the MCP SDK; this module owns the callback listener and the grant this plugin stores.
 */
import { randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import {
  discoverOAuthServerInfo,
  exchangeAuthorization,
  refreshAuthorization,
  registerClient,
  startAuthorization,
} from '@modelcontextprotocol/client'

/** What this plugin stores in the credential record of an OAuth connector. The access token lives in the reference. */
export interface OAuthGrant {
  readonly authorizationServerUrl: string
  readonly resource: string
  readonly clientId: string
  readonly refreshToken?: string
  /** Epoch milliseconds when the access token expires; absent when the server gave no lifetime. */
  readonly expiresAt?: number
}

/** Tokens from a code exchange or a refresh. */
export interface IssuedTokens {
  readonly accessToken: string
  readonly grant: OAuthGrant
}

/** A sign-in waiting for the browser. */
export interface PendingSignIn {
  /** The authorization page to open. */
  readonly url: string
  /** Settles with the tokens once the browser returns to the callback, or rejects on refusal, timeout or abort. */
  readonly done: Promise<IssuedTokens>
}

/** The SDK functions the flow calls; tests replace them. */
export interface OAuthProtocol {
  discoverOAuthServerInfo: typeof discoverOAuthServerInfo
  registerClient: typeof registerClient
  startAuthorization: typeof startAuthorization
  exchangeAuthorization: typeof exchangeAuthorization
  refreshAuthorization: typeof refreshAuthorization
}

/** The MCP SDK's implementation. */
export const SDK_PROTOCOL: OAuthProtocol = {
  discoverOAuthServerInfo, registerClient, startAuthorization, exchangeAuthorization, refreshAuthorization,
}

/** A client registered with the provider ahead of time. */
export interface StaticClient {
  readonly clientId: string
  readonly clientSecret?: string
}

/** Sign-in options. */
export interface SignInOptions {
  /** MCP endpoint whose authorization server is discovered. */
  readonly serverUrl: string
  /** `client_name` sent at registration and shown on the consent page. */
  readonly clientName: string
  /** A pre-registered client; without it the client is registered dynamically. */
  readonly client?: StaticClient
  /** Scopes to request instead of the advertised ones. */
  readonly scopes?: readonly string[]
  /** Fixed loopback port, for providers that match the redirect URI exactly (Google, Slack); 0 or absent picks a free one. */
  readonly callbackPort?: number
  /** Extra authorization request parameters, such as Google's `access_type=offline`. */
  readonly authorizationParams?: Readonly<Record<string, string>>
  /** How long the callback waits for the browser, in milliseconds. */
  readonly timeoutMs: number
  readonly signal: AbortSignal
  readonly protocol?: OAuthProtocol
  readonly now?: () => number
}

/** The callback page the browser shows after the redirect. */
function page(title: string, detail: string): string {
  const escape = (text: string) => text.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)
  return `<!doctype html><meta charset="utf-8"><title>${escape(title)}</title>`
    + `<body style="font:15px system-ui;margin:15vh auto;max-width:28rem;text-align:center">`
    + `<h1 style="font-size:20px">${escape(title)}</h1><p>${escape(detail)}</p></body>`
}

/** A loopback listener that accepts exactly one callback carrying the expected `state`. */
interface Loopback {
  readonly redirectUri: string
  readonly params: Promise<URLSearchParams>
  close(): void
}

async function listen(state: string, timeoutMs: number, signal: AbortSignal, port: number): Promise<Loopback> {
  const { promise, resolve, reject } = Promise.withResolvers<URLSearchParams>()
  let settled = false
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (request.method !== 'GET' || url.pathname !== '/callback' || settled) {
      response.writeHead(404, { 'content-type': 'text/plain' }).end('Not found')
      return
    }
    if (url.searchParams.get('state') !== state) {
      response.writeHead(400, { 'content-type': 'text/html; charset=utf-8' })
        .end(page('Sign-in failed', 'This sign-in link is not the one DeepSeek Harness started. Start again from Settings.'))
      return
    }
    settled = true
    const error = url.searchParams.get('error')
    response.writeHead(error === null ? 200 : 400, { 'content-type': 'text/html; charset=utf-8', 'connection': 'close' })
      .end(error === null
        ? page('Connected', 'You can close this tab and go back to DeepSeek Harness.')
        : page('Sign-in failed', url.searchParams.get('error_description') ?? error))
    resolve(url.searchParams)
  })
  const close = (): void => {
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
    server.close()
    server.closeAllConnections()
  }
  const fail = (reason: Error): void => {
    if (settled) return
    settled = true
    reject(reason)
    close()
  }
  const onAbort = (): void => { fail(new Error('The sign-in was cancelled.')) }
  const timer = setTimeout(() => { fail(new Error('The sign-in timed out. Start it again.')) }, timeoutMs)
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    await new Promise<void>((done, failed) => {
      server.once('error', failed)
      server.listen(port, '127.0.0.1', () => { server.off('error', failed); done() })
    })
  } catch (error) {
    close()
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') throw new Error(`The sign-in callback port ${port} is in use. Close what uses it, or another sign-in, and try again.`)
    throw error
  }
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('the loopback listener has no port')
  // Give the confirmation page time to flush before the listener drops its connections.
  promise.then(() => { clearTimeout(timer); setTimeout(close, 500).unref() }, () => {})
  return { redirectUri: `http://127.0.0.1:${address.port}/callback`, params: promise, close }
}

/** SDK client information for a pre-registered client; a secret is sent in the token request body. */
function clientInformation(client: StaticClient): { client_id: string; client_secret?: string; token_endpoint_auth_method?: string } {
  return client.clientSecret === undefined
    ? { client_id: client.clientId, token_endpoint_auth_method: 'none' }
    : { client_id: client.clientId, client_secret: client.clientSecret, token_endpoint_auth_method: 'client_secret_post' }
}

/**
 * Whether a URL may be opened in the browser: https, or http to this machine.
 * @param url Candidate URL.
 * @returns True for a page the browser can safely navigate to.
 */
export function isWebUrl(url: URL): boolean {
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  return url.protocol === 'https:' || (url.protocol === 'http:' && loopback)
}

function grantFrom(base: Omit<OAuthGrant, 'refreshToken' | 'expiresAt'>, tokens: { refresh_token?: string | undefined; expires_in?: number | undefined }, previousRefresh: string | undefined, now: number): OAuthGrant {
  const refreshToken = tokens.refresh_token ?? previousRefresh
  return {
    ...base,
    ...refreshToken === undefined ? {} : { refreshToken },
    ...tokens.expires_in === undefined ? {} : { expiresAt: now + tokens.expires_in * 1000 },
  }
}

/**
 * Start a sign-in: discover the authorization server, register a client for this loopback port, and build the
 * authorization URL. The returned `done` finishes the exchange once the browser comes back.
 * @param options Server and limits.
 * @returns The page to open and the pending result.
 */
export async function startSignIn(options: SignInOptions): Promise<PendingSignIn> {
  const protocol = options.protocol ?? SDK_PROTOCOL
  const now = options.now ?? Date.now
  const info = await protocol.discoverOAuthServerInfo(options.serverUrl)
  const metadata = info.authorizationServerMetadata
  if (metadata === undefined) throw new Error(`${options.serverUrl} publishes no OAuth authorization server metadata`)
  if (options.client === undefined && metadata.registration_endpoint === undefined) {
    throw new Error(`${info.authorizationServerUrl} does not support dynamic client registration; the connector needs a registered client`)
  }
  const resource = info.resourceMetadata?.resource ?? options.serverUrl
  const offline = metadata.scopes_supported?.includes('offline_access') === true ? ['offline_access'] : []
  const scopes = options.scopes ?? [...new Set([...info.resourceMetadata?.scopes_supported ?? [], ...offline])]
  const scope = scopes.length === 0 ? undefined : scopes.join(' ')

  const state = randomBytes(24).toString('base64url')
  const loopback = await listen(state, options.timeoutMs, options.signal, options.callbackPort ?? 0)
  try {
    const client = options.client !== undefined
      ? clientInformation(options.client)
      : await protocol.registerClient(info.authorizationServerUrl, {
        metadata,
        clientMetadata: {
          client_name: options.clientName,
          redirect_uris: [loopback.redirectUri],
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none',
          ...scope === undefined ? {} : { scope },
        },
      })
    const { authorizationUrl, codeVerifier } = await protocol.startAuthorization(info.authorizationServerUrl, {
      metadata, clientInformation: client, redirectUrl: loopback.redirectUri, state, resource,
      ...scope === undefined ? {} : { scope },
    })
    for (const [key, value] of Object.entries(options.authorizationParams ?? {})) authorizationUrl.searchParams.set(key, value)
    if (!isWebUrl(authorizationUrl)) throw new Error(`the authorization server sent an authorization URL that is not http(s): ${authorizationUrl.protocol}`)
    const done = loopback.params.then(async (params) => {
      const error = params.get('error')
      if (error !== null) throw new Error(`The sign-in was refused: ${params.get('error_description') ?? error}`)
      const code = params.get('code')
      if (code === null) throw new Error('The authorization server returned no code.')
      const iss = params.get('iss')
      const tokens = await protocol.exchangeAuthorization(info.authorizationServerUrl, {
        metadata, clientInformation: client, authorizationCode: code, codeVerifier, redirectUri: loopback.redirectUri, resource,
        ...iss === null ? {} : { iss },
      })
      return {
        accessToken: tokens.access_token,
        grant: grantFrom({ authorizationServerUrl: info.authorizationServerUrl, resource, clientId: client.client_id }, tokens, undefined, now()),
      }
    })
    return { url: authorizationUrl.href, done }
  } catch (error) {
    loopback.close()
    throw error
  }
}

/**
 * Exchange a stored refresh token for a new access token.
 * @param grant The stored grant; it must carry a refresh token.
 * @param protocol SDK functions.
 * @param now Clock.
 * @param client The connector's pre-registered client, whose secret a renewal may need.
 * @returns The new access token and the grant to store.
 */
export async function refresh(grant: OAuthGrant, protocol: OAuthProtocol = SDK_PROTOCOL, now: () => number = Date.now, client?: StaticClient): Promise<IssuedTokens> {
  if (grant.refreshToken === undefined) throw new Error('The sign-in expired and cannot be renewed. Connect again.')
  const info = await protocol.discoverOAuthServerInfo(grant.resource)
  const tokens = await protocol.refreshAuthorization(grant.authorizationServerUrl, {
    ...info.authorizationServerMetadata === undefined ? {} : { metadata: info.authorizationServerMetadata },
    clientInformation: client !== undefined && client.clientId === grant.clientId ? clientInformation(client) : { client_id: grant.clientId },
    refreshToken: grant.refreshToken,
    resource: grant.resource,
  })
  const { refreshToken: previous, expiresAt: _expired, ...base } = grant
  void _expired
  return { accessToken: tokens.access_token, grant: grantFrom(base, tokens, previous, now()) }
}

/**
 * Read a grant back from a credential record payload.
 * @param payload Stored payload.
 * @returns The grant, or undefined when the payload is not one this plugin wrote.
 */
export function parseGrant(payload: unknown): OAuthGrant | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const value = payload as Record<string, unknown>
  if (typeof value.authorizationServerUrl !== 'string' || typeof value.resource !== 'string' || typeof value.clientId !== 'string') return undefined
  return {
    authorizationServerUrl: value.authorizationServerUrl,
    resource: value.resource,
    clientId: value.clientId,
    ...typeof value.refreshToken === 'string' ? { refreshToken: value.refreshToken } : {},
    ...typeof value.expiresAt === 'number' ? { expiresAt: value.expiresAt } : {},
  }
}
