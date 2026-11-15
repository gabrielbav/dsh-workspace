/**
 * Public API of the `connectors` service. Another plugin adds a connector by injecting the service and registering a
 * definition inside an effect, so its row disappears when that plugin unloads:
 *
 * ```ts
 * export const inject = ['connectors']
 * export function apply(ctx) {
 *   ctx.effect(() => ctx.connectors.register({ id: 'linear', name: 'Linear', … }))
 * }
 * ```
 *
 * The service owns the Settings page, sign-in, token storage and the MCP server registration. A definition only
 * describes the connector.
 */

/** MCP server entry handed to the MCP manager (`McpServerRegistration`). */
export type ConnectorServer =
  | {
    readonly transport: 'streamable-http'
    readonly url: string
    readonly headers?: Readonly<Record<string, string>>
    readonly startupTimeoutMs?: number
  }
  | {
    readonly transport: 'stdio'
    readonly command: string
    readonly args?: readonly string[]
    readonly env?: Readonly<Record<string, string>>
    readonly startupTimeoutMs?: number
  }

/** What {@link ConnectorDefinition.server} receives. */
export interface ServerInput {
  /** `${credential:REF}` template of the stored credential; put it where the server reads its token. */
  readonly credential: string
  /** Non-secret values the token form collected (for example an organization name). */
  readonly values: Readonly<Record<string, string>>
}

/** OAuth 2.1 with PKCE against the authorization server the MCP endpoint advertises (RFC 9728). */
export interface OAuthMethod {
  /** MCP endpoint whose protected resource metadata names the authorization server. */
  readonly resourceUrl: string
  /** A pre-registered client. Omit it when the authorization server supports Dynamic Client Registration. */
  readonly client?: { readonly clientId: string; readonly clientSecret?: string }
  /** Scopes to request; defaults to the resource's `scopes_supported` plus `offline_access` when offered. */
  readonly scopes?: readonly string[]
  /** Read the account an access token belongs to; shown as "as <account>". */
  readonly identify?: (accessToken: string, fetchFn: typeof fetch) => Promise<string>
  /** Page where the user grants access after signing in (for example a GitHub App's repository picker). */
  readonly setupUrl?: string
  /** Fixed loopback callback port, for providers that match the redirect URI exactly. */
  readonly callbackPort?: number
  /** Extra authorization request parameters (for example Google's `access_type: 'offline'`). */
  readonly authorizationParams?: Readonly<Record<string, string>>
}

/** Why a connector cannot connect yet and where to read how to set it up. */
export interface ConnectorSetup {
  readonly reason: string
  readonly helpUrl?: string
}

/** One input of the token form. */
export interface TokenField {
  readonly id: string
  readonly label: string
  /** Secret fields are sent to the Host once and never stored outside the credential store. */
  readonly secret?: boolean
  readonly placeholder?: string
}

/** What {@link TokenMethod.verify} returns. */
export interface VerifiedToken {
  /** The value stored in the credential reference; the server reads it through {@link ServerInput.credential}. */
  readonly credential: string
  /** Account the token belongs to. */
  readonly account?: string
  /** Non-secret form values kept for {@link ConnectorDefinition.server}. */
  readonly values?: Readonly<Record<string, string>>
}

/** A token the user pastes, with any other values the server needs. */
export interface TokenMethod {
  readonly fields: readonly TokenField[]
  /** Where the user creates the token. */
  readonly helpUrl?: string
  /**
   * Check the form values with the provider and turn them into the stored credential.
   * @throws an Error whose message the form shows when the provider refuses them.
   */
  readonly verify: (values: Readonly<Record<string, string>>, fetchFn: typeof fetch) => Promise<VerifiedToken>
}

/** One connector. It needs `oauth`, `token` or `setup`; OAuth is offered first when both methods exist. */
export interface ConnectorDefinition {
  /** `[a-z][a-z0-9-]{0,31}`: the MCP server name (tools are `mcp__<id>__<tool>`) and the credential id. */
  readonly id: string
  readonly name: string
  readonly description: string
  /** SVG markup drawn in the current text color (as a mask), so it follows the theme. */
  readonly icon?: string
  readonly oauth?: OAuthMethod
  readonly token?: TokenMethod
  /** Shown instead of Connect while the connector offers no method, for example before its app is configured. */
  readonly setup?: ConnectorSetup
  /** The MCP server to register while the connector is connected. */
  readonly server: (input: ServerInput) => ConnectorServer
}

/** The `connectors` service. */
export interface ConnectorsService {
  /**
   * Add a connector to the Settings page; a stored credential reconnects it at once.
   * @param definition The connector.
   * @returns A disposer that removes the row and its MCP server and keeps the stored credential.
   * @throws When the id is malformed or already registered, or the definition has no auth method.
   */
  register(definition: ConnectorDefinition): () => void
  /** @returns Every connector with its state, as the Settings page shows it. */
  list(): import('../shared.ts').ConnectorView[]
}
