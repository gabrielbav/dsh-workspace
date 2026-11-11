/** Values the Host half returns to the browser half over the `/api/sessionDelete.<endpoint>` routes. */

/**
 * Why one Session was kept.
 * - `running`: it runs a turn, a subagent, a background job or a schedule.
 * - `in-use`: its log is open elsewhere, by another DSH process or by a subagent or integration that owns it.
 * - `restart-required`: this DSH keeps it loaded and cannot unload it; restart DSH, or update to a DSH whose
 *   session controller offers `releaseAgent`.
 * - `subagent`: it is a subagent's session, deleted together with its parent.
 * - `not-found`: nothing is stored under the id.
 * - `unsupported-storage`: the session store is not the JSONL folder layout this plugin can verify.
 * - `failed`: deleting its files failed; `detail` holds the error.
 */
export type KeptReason = 'running' | 'in-use' | 'restart-required' | 'subagent' | 'not-found' | 'unsupported-storage' | 'failed'

/** One Session left in place. */
export interface KeptSession {
  readonly sessionId: string
  readonly reason: KeptReason
  /** Activity kinds for `running`, the error message for `failed`. */
  readonly detail?: string
}

/** Outcome of one delete request. */
export interface DeleteReport {
  /** Deleted Sessions, subagent sessions included. */
  readonly deleted: readonly string[]
  readonly kept: readonly KeptSession[]
  /** For a workspace request: whether the workspace itself was deleted (only when every session was). */
  readonly workspaceDeleted?: boolean
}

/** What this Host can do. */
export interface Capabilities {
  /** The session controller can unload idle sessions, so a session used since DSH started can be deleted. */
  readonly releaseIdle: boolean
}
