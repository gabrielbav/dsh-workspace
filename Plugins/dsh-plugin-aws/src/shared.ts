/** Wire types shared by the Host half and the browser half. */

/** One input of a server's settings form. */
export interface FieldView {
  readonly id: string
  readonly label: string
  readonly help?: string
  readonly placeholder?: string
  /** `secret` values go to the DSH credential store and are never sent back to the page. */
  readonly kind: 'text' | 'secret' | 'boolean' | 'select'
  readonly options?: readonly string[]
  readonly required?: boolean
}

/** What a server can be allowed to do beyond reading. */
export interface PermissionsView {
  /** The server can create, change or delete resources when allowed. */
  readonly write: boolean
  /** The server can return sensitive data (logs, secrets, events) when allowed. */
  readonly sensitive: boolean
}

/** One catalog server as the page shows it. */
export interface ServerInfo {
  /** `[a-z][a-z0-9-]*`: the MCP server name, so tools are `mcp__<id>__<tool>`. */
  readonly id: string
  readonly name: string
  readonly description: string
  readonly group: string
  readonly docsUrl: string
  /** How DSH reaches it: a remote endpoint, a remote endpoint through the AWS SigV4 proxy, or a local uvx process. */
  readonly runtime: 'remote' | 'proxy' | 'local'
  /** Exact package and version DSH runs, for local and proxied servers. */
  readonly package?: string
  /** Whether it reads the AWS profile and region. */
  readonly aws: boolean
  readonly fields: readonly FieldView[]
  /** At least one of these field ids must be filled. */
  readonly requireAny?: readonly string[]
  readonly permissions: PermissionsView
  /** Something the user must have outside DSH (a support plan, a local tool). */
  readonly note?: string
}

/** One group of servers; its switch turns every server in it on or off. */
export interface GroupInfo {
  readonly id: string
  readonly title: string
  readonly description: string
}

/** Live state of one enabled server, from the MCP manager. */
export type ServerState =
  | { readonly kind: 'off' }
  /** On, but a required setting is missing, so it is not registered. */
  | { readonly kind: 'needs-setup'; readonly missing: readonly string[] }
  /** On, but uvx is missing, so a local server cannot start. */
  | { readonly kind: 'needs-uv' }
  | { readonly kind: 'connecting'; readonly detail?: string }
  | { readonly kind: 'connected'; readonly toolCount: number }
  | { readonly kind: 'error'; readonly message: string }

/** A server with the user's settings and its state. */
export interface ServerView extends ServerInfo {
  readonly enabled: boolean
  /** Non-secret field values. */
  readonly values: Readonly<Record<string, string>>
  /** Ids of secret fields with a stored value. */
  readonly secretsSet: readonly string[]
  readonly allowWrite: boolean
  readonly allowSensitive: boolean
  /** Profile and region overrides; empty means the global setting. */
  readonly profile: string
  readonly region: string
  /** Extra `KEY=VALUE` environment lines for options the form does not cover. */
  readonly extraEnv: string
  readonly state: ServerState
}

/** Whether uvx was found on the Host. */
export interface UvStatus {
  readonly found: boolean
  readonly path?: string
  readonly version?: string
}

/** Answer to `list`. */
export interface Overview {
  readonly uv: UvStatus
  /** Global AWS profile and region; empty means the AWS SDK default chain. */
  readonly profile: string
  readonly region: string
  /** Profile names found in `~/.aws/config` and `~/.aws/credentials` (names only). */
  readonly profiles: readonly string[]
  readonly groups: readonly GroupInfo[]
  readonly servers: readonly ServerView[]
}

/** Payload of `configure`. Secret values that are `undefined` stay as stored; `''` deletes them. */
export interface ServerConfigInput {
  readonly id: string
  readonly values: Readonly<Record<string, string>>
  readonly secrets: Readonly<Record<string, string>>
  readonly allowWrite: boolean
  readonly allowSensitive: boolean
  readonly profile: string
  readonly region: string
  readonly extraEnv: string
}
