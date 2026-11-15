/** Calls to the Host half's `/api/connectors.<endpoint>` routes. */
import type { Capabilities, ConnectorView, CustomAdded, OAuthStart, PackageCheck, PackageInstall } from '../shared.ts'
import type { ClientContext } from './dsh.ts'

/** A Host answer the caller shows as an error message. */
export class ConnectorsRequestError extends Error {}

/** Typed Host endpoints. */
export interface ConnectorsApi {
  capabilities(): Promise<Capabilities>
  list(): Promise<ConnectorView[]>
  beginOAuth(id: string): Promise<OAuthStart>
  cancelOAuth(id: string): Promise<void>
  setToken(id: string, values: Readonly<Record<string, string>>): Promise<void>
  reconnect(id: string): Promise<void>
  disconnect(id: string): Promise<void>
  addCustom(name: string, url: string): Promise<CustomAdded>
  removeCustom(id: string): Promise<void>
  checkPackage(spec: string): Promise<PackageCheck>
  installPackage(name: string, version: string, gateAcknowledged?: string): Promise<PackageInstall>
}

/**
 * Bind the endpoints to the page connection.
 * @param ctx Client context.
 * @returns The endpoint calls; each rejects with {@link ConnectorsRequestError} on a Host refusal.
 */
export function connectorsApi(ctx: ClientContext): ConnectorsApi {
  const call = async <T>(endpoint: string, payload: unknown): Promise<T> => {
    const result = await ctx.connection.rpc.call('/api', `connectors.${endpoint}`, payload)
    if (!result.ok) throw new ConnectorsRequestError(result.error.message)
    return result.value as T
  }
  return {
    capabilities: () => call('capabilities', {}),
    list: () => call('list', {}),
    beginOAuth: id => call('beginOAuth', { id }),
    cancelOAuth: id => call('cancelOAuth', { id }),
    setToken: (id, values) => call('setToken', { id, values }),
    reconnect: id => call('reconnect', { id }),
    disconnect: id => call('disconnect', { id }),
    addCustom: (name, url) => call('addCustom', { name, url }),
    removeCustom: id => call('removeCustom', { id }),
    checkPackage: spec => call('checkPackage', { spec }),
    installPackage: (name, version, gateAcknowledged) => call('installPackage', { name, version, ...gateAcknowledged === undefined ? {} : { gateAcknowledged } }),
  }
}
