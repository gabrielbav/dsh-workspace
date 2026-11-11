/** Calls to the Host half's `/api/sessionDelete.<endpoint>` routes. */
import type { Capabilities, DeleteReport } from '../shared.ts'
import type { ClientContext } from './dsh.ts'

/** A Host answer the caller shows as an error message. */
export class SessionDeleteRequestError extends Error {}

/** Typed Host endpoints. */
export interface SessionDeleteApi {
  capabilities(): Promise<Capabilities>
  deleteSession(sessionId: string): Promise<DeleteReport>
  deleteWorkspace(workspaceId: string): Promise<DeleteReport>
}

/**
 * Bind the endpoints to the page connection.
 * @param ctx Client context.
 * @returns The endpoint calls; each rejects with {@link SessionDeleteRequestError} on a Host refusal.
 */
export function sessionDeleteApi(ctx: ClientContext): SessionDeleteApi {
  const call = async <T>(endpoint: string, payload: unknown): Promise<T> => {
    const result = await ctx.connection.rpc.call('/api', `sessionDelete.${endpoint}`, payload)
    if (!result.ok) throw new SessionDeleteRequestError(result.error.message)
    return result.value as T
  }
  return {
    capabilities: () => call('capabilities', {}),
    deleteSession: sessionId => call('deleteSession', { sessionId }),
    deleteWorkspace: workspaceId => call('deleteWorkspace', { workspaceId }),
  }
}
