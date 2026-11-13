/** Wire types shared by the Host half and the browser half. */

/** How a connector obtains the token its MCP server needs. */
export type AuthKind = 'oauth' | 'token'

/** Live state of one connector, derived from its stored credential and the MCP manager's server status. */
export type ConnectorState =
  | { readonly kind: 'disconnected' }
  /** An OAuth sign-in is waiting for the browser to come back to the loopback callback. */
  | { readonly kind: 'authorizing' }
  | { readonly kind: 'connecting'; readonly detail?: string }
  | { readonly kind: 'connected'; readonly toolCount: number }
  | { readonly kind: 'error'; readonly message: string }

/** One input of a token form. */
export interface TokenFieldView {
  readonly id: string
  readonly label: string
  readonly secret: boolean
  readonly placeholder?: string
}

/** One row of the Connectors table. */
export interface ConnectorView {
  readonly id: string
  readonly name: string
  readonly description: string
  /** SVG markup drawn as a mask in the current text color. */
  readonly icon?: string
  /** What the connector connects to; every connector is an MCP server today. */
  readonly type: 'mcp'
  /** Offered sign-in methods, preferred first. */
  readonly auth: readonly AuthKind[]
  /** Token form inputs, when `auth` includes `token`. */
  readonly fields?: readonly TokenFieldView[]
  /** Where a token is created. */
  readonly tokenUrl?: string
  /** Where access is granted after an OAuth sign-in (for example choosing repositories). */
  readonly setupUrl?: string
  /** Account the stored credential belongs to, when the provider reports one. */
  readonly account?: string
  /** How the stored credential was obtained. */
  readonly via?: AuthKind
  /** Whether its MCP server is registered, so Reconnect can rebuild the connection. */
  readonly registered: boolean
  /** Why the connector cannot connect yet, with where to read how to set it up. */
  readonly setup?: { readonly reason: string; readonly helpUrl?: string }
  /** A custom connector the user added, which Remove deletes. */
  readonly custom?: boolean
  readonly state: ConnectorState
}

/** Answer to `beginOAuth`: the page to open in the browser. */
export interface OAuthStart {
  readonly url: string
}

/** What the page knows about the Host's add options. */
export interface Capabilities {
  /** Whether the plugin manager is available, so connector packages can be installed. */
  readonly packages: boolean
}

/** Answer to `addCustom`. */
export interface CustomAdded {
  readonly id: string
  readonly auth: AuthKind
}

/** Answer to `checkPackage`. */
export type PackageCheck =
  | { readonly ok: true; readonly name: string; readonly version: string; readonly description?: string; readonly connectorIds: readonly string[] }
  | { readonly ok: false; readonly reason: string }

/** An install gate's report, shortened for the page. */
export interface GateSummary {
  readonly digest: string
  readonly level: 'review' | 'block'
  readonly score?: number
  readonly reasons: readonly string[]
  readonly findings: readonly string[]
}

/** Answer to `installPackage`. */
export type PackageInstall =
  | { readonly status: 'installed' | 'restart-required'; readonly gate?: GateSummary }
  | { readonly status: 'review' | 'blocked'; readonly gate: GateSummary }
  | { readonly status: 'failed'; readonly reason: string }
