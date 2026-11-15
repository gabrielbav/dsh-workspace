/** Calls to the Host half's `/api/awsMcp.<endpoint>` routes. */
import type { Overview, ServerConfigInput } from '../shared.ts'
import type { ClientContext } from './dsh.ts'

/** A Host answer the caller shows as an error message. */
export class AwsRequestError extends Error {}

/** Typed Host endpoints. */
export interface AwsApi {
  list(): Promise<Overview>
  setGlobal(profile: string, region: string): Promise<void>
  setEnabled(ids: readonly string[], enabled: boolean): Promise<void>
  configure(input: ServerConfigInput): Promise<void>
  restart(id: string): Promise<void>
}

/**
 * Bind the endpoints to the page connection.
 * @param ctx Client context.
 * @returns The endpoint calls; each rejects with {@link AwsRequestError} on a Host refusal.
 */
export function awsApi(ctx: ClientContext): AwsApi {
  const call = async <T>(endpoint: string, payload: unknown): Promise<T> => {
    const result = await ctx.connection.rpc.call('/api', `awsMcp.${endpoint}`, payload)
    if (!result.ok) throw new AwsRequestError(result.error.message)
    return result.value as T
  }
  return {
    list: () => call('list', {}),
    setGlobal: (profile, region) => call('setGlobal', { profile, region }),
    setEnabled: (ids, enabled) => call('setEnabled', { ids, enabled }),
    configure: input => call('configure', input),
    restart: id => call('restart', { id }),
  }
}
