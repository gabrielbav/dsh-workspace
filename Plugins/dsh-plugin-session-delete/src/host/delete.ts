/**
 * Permanent Session deletion. One Session is deleted with its subagent sessions, only when none of them runs work
 * and every log can be opened for writing, which proves no other owner or DSH process writes it. The folders are
 * removed only after each one is verified to be a Session folder directly under the JSONL root; the Workspace
 * registry is cleaned afterwards and Clients are told the Session is gone.
 */
import { lstat, readdir, realpath, rm } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { DeleteReport, KeptReason, KeptSession } from '../shared.ts'
import type { PersistenceSnapshot, ReleaseResult, SessionActivity, SessionHandle, SessionHeader, SessionPersistence, WorkspaceRegistry } from './dsh.ts'

/** What deletion needs from the Host. */
export interface DeleteDeps {
  readonly persistence: SessionPersistence
  readonly registry: WorkspaceRegistry
  /** Session header of a live Session, or undefined when none is live. */
  readonly liveHeader: (id: string) => SessionHeader | undefined
  /** Whether a Session or its Agent is live in this process. */
  readonly isLive: (id: string) => boolean
  /** The session controller's `releaseAgent`, when this DSH provides it. */
  readonly release: ((id: string) => Promise<ReleaseResult>) | undefined
  /** Work the `workspace/session-activity` providers report for a Session. */
  readonly activity: (id: string) => Promise<readonly SessionActivity[]>
  /** Ask the owners of a Session's running work to stop it. Without it a running Session is kept. */
  readonly stop?: (id: string) => Promise<void>
  /** Wait between two looks at a stopping Session; real time unless a test gives its own. */
  readonly pause?: (ms: number) => Promise<void>
  /** How long a stopping Session may take to go quiet. */
  readonly stopWaitMs?: number
  /** Tell Clients a Session is gone. */
  readonly removed: (id: string) => void
  readonly warn: (message: string, error?: unknown) => void
}

/** A Session that cannot be deleted now. */
class Kept extends Error {
  constructor(readonly reason: KeptReason, readonly detail?: string) {
    super(reason)
  }
}

/** Generation files a Session folder may hold: `session.jsonl`, `session.v4.jsonl`, either compressed. */
const SESSION_FILE = /^session(\.v\d+)?\.jsonl(\.[a-z0-9]+)?$/

/** How often a stopping Session is looked at, and how long it may take by default. */
const STOP_POLL_MS = 200
const STOP_WAIT_MS = 10_000

/** The stack's answer when it cannot unload a Session now: it archived it and queued the delete. */
function isQueued(error: unknown): error is Error {
  if (!(error instanceof Error)) return false
  const flags = error as Error & { code?: unknown; queued?: unknown }
  return flags.code === 'AGENTIC_QUEUED' || flags.queued === true
}

function activityDetail(activity: readonly SessionActivity[]): string {
  return [...new Set(activity.map(entry => entry.kind))].join(', ')
}

/**
 * Bind the deletion operations to the Host; operations run one at a time.
 * @param deps Host services.
 * @returns Session and Workspace deletion.
 */
export function sessionDeleter(deps: DeleteDeps) {
  let tail: Promise<unknown> = Promise.resolve()
  const serial = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation)
    tail = result.catch(() => undefined)
    return result
  }

  const header = async (id: string): Promise<SessionHeader | undefined> =>
    deps.liveHeader(id) ?? (await deps.persistence.stat(id))?.header

  /** The Session and every subagent session below it, parents first. */
  const tree = (rootId: string, stored: readonly PersistenceSnapshot[]): string[] => {
    const ids = [rootId]
    for (let index = 0; index < ids.length; index++) {
      const parent = ids[index]
      for (const snapshot of stored) {
        if (snapshot.header.origin === 'subagent' && snapshot.header.parentSession === parent && !ids.includes(snapshot.header.id)) {
          ids.push(snapshot.header.id)
        }
      }
    }
    return ids
  }

  /** Unload a live Session through the session controller, or explain why it stays. */
  const unload = async (id: string): Promise<void> => {
    if (!deps.isLive(id)) return
    if (deps.release === undefined) throw new Kept('restart-required')
    let result: ReleaseResult
    try { result = await deps.release(id) }
    catch (error) {
      if (isQueued(error)) throw new Kept('queued', error.message)
      throw error
    }
    if (!result.released && result.reason === 'active') throw new Kept('running', activityDetail(result.activity))
    if (deps.isLive(id)) throw new Kept('in-use')
  }

  /**
   * Stop whatever the Sessions run and wait until they are quiet. Returns what still runs, root Session first;
   * empty when all are quiet.
   */
  const quiet = async (ids: readonly string[]): Promise<readonly SessionActivity[]> => {
    const running = async (): Promise<readonly SessionActivity[]> => {
      const found: SessionActivity[] = []
      for (const sessionId of ids) found.push(...await deps.activity(sessionId))
      return found
    }
    let left = await running()
    if (left.length === 0 || deps.stop === undefined) return left
    for (const sessionId of ids) if ((await deps.activity(sessionId)).length > 0) await deps.stop(sessionId)
    const pause = deps.pause ?? (ms => new Promise<void>(done => setTimeout(done, ms)))
    for (let waited = 0; waited < (deps.stopWaitMs ?? STOP_WAIT_MS); waited += STOP_POLL_MS) {
      left = await running()
      if (left.length === 0) return left
      await pause(STOP_POLL_MS)
    }
    return running()
  }

  /** The verified folder of one Session, or undefined when nothing is on disk. */
  const folder = async (id: string, root: string): Promise<string | undefined> => {
    const snapshot = await deps.persistence.stat(id)
    if (snapshot === undefined) throw new Kept('not-found')
    if (snapshot.header.id !== id) throw new Kept('failed', `stored header names ${snapshot.header.id}`)
    const location = snapshot.location
    if (location === undefined) return undefined
    if (location.kind !== 'jsonl' || !isAbsolute(location.path) || !SESSION_FILE.test(basename(location.path))) {
      throw new Kept('unsupported-storage')
    }
    const dir = dirname(location.path)
    const info = await lstat(dir)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Kept('failed', `${dir} is not a plain folder`)
    const segments = relative(root, await realpath(dir)).split(sep)
    if (segments.length !== 2 || segments.some(segment => segment === '' || segment === '..')) {
      throw new Kept('failed', `${dir} is not a session folder under ${root}`)
    }
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory() || entry.isSymbolicLink()) throw new Kept('failed', `${dir} holds an unexpected entry ${entry.name}`)
    }
    return dir
  }

  const storeRoot = async (): Promise<string> => {
    const root = deps.persistence.config?.root
    if (typeof root !== 'string' || root === '') throw new Kept('unsupported-storage')
    return realpath(resolve(root))
  }

  /** Delete one top-level Session with its subagent sessions. */
  const deleteOne = async (id: string): Promise<string[]> => {
    const found = await header(id)
    if (found === undefined) throw new Kept('not-found')
    if (found.origin === 'subagent') throw new Kept('subagent')
    const root = await storeRoot()
    const ids = tree(id, await deps.persistence.list())
    const activity = await quiet(ids)
    if (activity.length > 0) throw new Kept('running', activityDetail(activity))
    await unload(id)
    for (const child of ids.slice(1)) await unload(child)

    const handles: SessionHandle[] = []
    try {
      for (const sessionId of ids) {
        try { handles.push(await deps.persistence.open(sessionId, 'write')) }
        catch (error) {
          if (error instanceof Error && error.name === 'SessionAlreadyOwnedError') throw new Kept('in-use')
          throw error
        }
      }
      const folders = new Map<string, string | undefined>()
      for (const sessionId of ids) folders.set(sessionId, await folder(sessionId, root))
      const members = ids.map(sessionId => ({
        sessionId,
        workspaces: deps.registry.list().filter(workspace => workspace.sessionIds.includes(sessionId)),
        pinned: deps.registry.pinnedSessionIds.includes(sessionId),
      }))
      for (const dir of folders.values()) if (dir !== undefined) await rm(dir, { recursive: true })
      for (const member of members) {
        for (const workspace of member.workspaces) await workspace.detachSession(member.sessionId)
        if (member.pinned) await deps.registry.unpinSession(member.sessionId)
      }
    } finally {
      for (const handle of handles) {
        try { await handle.close() }
        catch (error) { deps.warn('session-delete: closing a deleted session log failed', error) }
      }
    }
    for (const sessionId of ids) deps.removed(sessionId)
    return ids
  }

  /** Delete one Session, reporting a refusal instead of throwing it. */
  const attempt = async (id: string): Promise<{ deleted: string[] } | { kept: KeptSession }> => {
    try { return { deleted: await deleteOne(id) } }
    catch (error) {
      if (error instanceof Kept) return { kept: { sessionId: id, reason: error.reason, ...error.detail === undefined ? {} : { detail: error.detail } } }
      deps.warn(`session-delete: deleting session ${id} failed`, error)
      return { kept: { sessionId: id, reason: 'failed', detail: error instanceof Error ? error.message : String(error) } }
    }
  }

  return {
    /**
     * Delete one Session and its subagent sessions.
     * @param id Session to delete.
     * @returns what was deleted, or why the Session was kept.
     */
    deleteSession: (id: string): Promise<DeleteReport> => serial(async () => {
      const outcome = await attempt(id)
      return 'deleted' in outcome ? { deleted: outcome.deleted, kept: [] } : { deleted: [], kept: [outcome.kept] }
    }),

    /**
     * Delete every Session of a Workspace, then the Workspace when none was kept. Subagent and already
     * missing members do not keep the Workspace.
     * @param workspaceId Workspace to delete.
     * @returns what was deleted, what was kept, and whether the Workspace was deleted.
     */
    deleteWorkspace: (workspaceId: string): Promise<DeleteReport | undefined> => serial(async () => {
      const workspace = deps.registry.get(workspaceId)
      if (workspace === undefined) return undefined
      const deleted: string[] = []
      const kept: KeptSession[] = []
      for (const sessionId of [...workspace.sessionIds]) {
        if (deleted.includes(sessionId)) continue
        const outcome = await attempt(sessionId)
        if ('deleted' in outcome) deleted.push(...outcome.deleted)
        else if (outcome.kept.reason !== 'subagent' && outcome.kept.reason !== 'not-found') kept.push(outcome.kept)
      }
      const workspaceDeleted = kept.length === 0 && await deps.registry.delete(workspaceId)
      return { deleted, kept, workspaceDeleted }
    }),
  }
}
