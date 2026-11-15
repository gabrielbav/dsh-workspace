import { mkdir, mkdtemp, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sessionDeleter, type DeleteDeps } from '../src/host/delete.ts'
import type { PersistenceSnapshot, ReleaseResult, SessionHeader, Workspace } from '../src/host/dsh.ts'

let root: string
beforeEach(async () => { root = await realpath(await mkdtemp(join(tmpdir(), 'session-delete-'))) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

const exists = async (path: string): Promise<boolean> => stat(path).then(() => true, () => false)

interface Fixture {
  deps: DeleteDeps
  stored: Map<string, PersistenceSnapshot>
  live: Set<string>
  removed: string[]
  closed: string[]
  owned: Set<string>
  workspaces: Map<string, Workspace & { ids: string[] }>
  pinned: string[]
  activity: Map<string, readonly { kind: string }[]>
  release: { fn: ((id: string) => Promise<ReleaseResult>) | undefined }
}

/** Store one Session folder under `<root>/<project>/<id>/session.v4.jsonl`. */
async function store(f: Fixture, header: SessionHeader, project = 'proj'): Promise<string> {
  const dir = join(root, project, header.id)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'session.v4.jsonl'), '{}\n')
  await writeFile(join(dir, 'session.lock'), '')
  f.stored.set(header.id, { header, location: { kind: 'jsonl', path: join(dir, 'session.v4.jsonl') } })
  return dir
}

function fixture(): Fixture {
  const f = {
    stored: new Map<string, PersistenceSnapshot>(),
    live: new Set<string>(),
    removed: [] as string[],
    closed: [] as string[],
    owned: new Set<string>(),
    workspaces: new Map<string, Workspace & { ids: string[] }>(),
    pinned: [] as string[],
    activity: new Map<string, readonly { kind: string }[]>(),
    release: { fn: undefined as ((id: string) => Promise<ReleaseResult>) | undefined },
  } as Fixture
  f.deps = {
    persistence: {
      config: { root },
      list: async () => [...f.stored.values()],
      stat: async id => f.stored.get(id),
      open: async (id) => {
        if (f.owned.has(id)) throw Object.assign(new Error(`session "${id}" is owned`), { name: 'SessionAlreadyOwnedError' })
        return { close: async () => { f.closed.push(id) } }
      },
    },
    registry: {
      get: id => f.workspaces.get(id),
      list: () => [...f.workspaces.values()],
      delete: async id => f.workspaces.delete(id),
      get pinnedSessionIds() { return f.pinned },
      unpinSession: async (id) => { f.pinned.splice(f.pinned.indexOf(id), 1) },
    },
    liveHeader: id => f.live.has(id) ? f.stored.get(id)?.header : undefined,
    isLive: id => f.live.has(id),
    get release() { return f.release.fn },
    activity: async id => f.activity.get(id) ?? [],
    removed: (id) => { f.removed.push(id) },
    warn: () => {},
  }
  return f
}

function workspace(f: Fixture, id: string, ids: string[]): void {
  const entity = {
    id, ids,
    get sessionIds() { return entity.ids },
    detachSession: async (sessionId: string) => { entity.ids = entity.ids.filter(item => item !== sessionId) },
  }
  f.workspaces.set(id, entity)
}

describe('deleteSession', () => {
  it('deletes a cold session with its subagent sessions and cleans the registry', async () => {
    const f = fixture()
    const parent = await store(f, { id: 'parent', cwd: '/w' })
    const child = await store(f, { id: 'child', cwd: '/w', parentSession: 'parent', origin: 'subagent' })
    const grandchild = await store(f, { id: 'grandchild', cwd: '/w', parentSession: 'child', origin: 'subagent' })
    const other = await store(f, { id: 'other', cwd: '/w' })
    workspace(f, 'ws', ['parent', 'other'])
    f.pinned.push('parent')

    const report = await sessionDeleter(f.deps).deleteSession('parent')

    expect(report).toEqual({ deleted: ['parent', 'child', 'grandchild'], kept: [] })
    for (const dir of [parent, child, grandchild]) expect(await exists(dir)).toBe(false)
    expect(await exists(other)).toBe(true)
    expect(await readdir(join(root, 'proj'))).toEqual(['other'])
    expect(f.workspaces.get('ws')?.sessionIds).toEqual(['other'])
    expect(f.pinned).toEqual([])
    expect(f.removed).toEqual(['parent', 'child', 'grandchild'])
    expect(f.closed).toEqual(['parent', 'child', 'grandchild'])
  })

  it('keeps a session that reports work, without touching the disk', async () => {
    const f = fixture()
    const dir = await store(f, { id: 'busy', cwd: '/w' })
    f.activity.set('busy', [{ kind: 'schedule' }, { kind: 'job' }, { kind: 'job' }])
    expect(await sessionDeleter(f.deps).deleteSession('busy'))
      .toEqual({ deleted: [], kept: [{ sessionId: 'busy', reason: 'running', detail: 'schedule, job' }] })
    expect(await exists(dir)).toBe(true)
    expect(f.removed).toEqual([])
  })

  it('needs a restart for a live session when the controller cannot release it', async () => {
    const f = fixture()
    const dir = await store(f, { id: 'loaded', cwd: '/w' })
    f.live.add('loaded')
    expect((await sessionDeleter(f.deps).deleteSession('loaded')).kept).toEqual([{ sessionId: 'loaded', reason: 'restart-required' }])
    expect(await exists(dir)).toBe(true)
  })

  it('releases an idle live session through the controller, then deletes it', async () => {
    const f = fixture()
    const dir = await store(f, { id: 'loaded', cwd: '/w' })
    f.live.add('loaded')
    f.release.fn = vi.fn(async (id: string) => { f.live.delete(id); return { released: true } as const })
    expect(await sessionDeleter(f.deps).deleteSession('loaded')).toEqual({ deleted: ['loaded'], kept: [] })
    expect(f.release.fn).toHaveBeenCalledWith('loaded')
    expect(await exists(dir)).toBe(false)
  })

  it('maps release refusals: running work, and an Agent another owner keeps live', async () => {
    const f = fixture()
    await store(f, { id: 'running', cwd: '/w' })
    await store(f, { id: 'foreign', cwd: '/w' })
    f.live.add('running').add('foreign')
    f.release.fn = async id => id === 'running'
      ? { released: false, reason: 'active', activity: [{ kind: 'turn' }] }
      : { released: false, reason: 'not-owned' }
    const deleter = sessionDeleter(f.deps)
    expect((await deleter.deleteSession('running')).kept).toEqual([{ sessionId: 'running', reason: 'running', detail: 'turn' }])
    expect((await deleter.deleteSession('foreign')).kept).toEqual([{ sessionId: 'foreign', reason: 'in-use' }])
  })

  it('keeps the whole tree when a subagent session stays live', async () => {
    const f = fixture()
    const parent = await store(f, { id: 'parent', cwd: '/w' })
    await store(f, { id: 'child', cwd: '/w', parentSession: 'parent', origin: 'subagent' })
    f.live.add('child')
    expect((await sessionDeleter(f.deps).deleteSession('parent')).kept).toEqual([{ sessionId: 'parent', reason: 'restart-required' }])
    expect(await exists(parent)).toBe(true)
  })

  it('keeps a session whose log another process writes, and closes what it opened', async () => {
    const f = fixture()
    const parent = await store(f, { id: 'parent', cwd: '/w' })
    await store(f, { id: 'child', cwd: '/w', parentSession: 'parent', origin: 'subagent' })
    f.owned.add('child')
    expect((await sessionDeleter(f.deps).deleteSession('parent')).kept).toEqual([{ sessionId: 'parent', reason: 'in-use' }])
    expect(await exists(parent)).toBe(true)
    expect(f.closed).toEqual(['parent'])
    expect(f.removed).toEqual([])
  })

  it('refuses folders it cannot verify', async () => {
    const f = fixture()
    const nested = await store(f, { id: 'nested', cwd: '/w' })
    await mkdir(join(nested, 'unexpected'))
    const outside = await realpath(await mkdtemp(join(tmpdir(), 'session-delete-outside-')))
    try {
      await mkdir(join(outside, 'escaped'))
      await writeFile(join(outside, 'escaped', 'session.v4.jsonl'), '{}\n')
      f.stored.set('escaped', { header: { id: 'escaped', cwd: '/w' }, location: { kind: 'jsonl', path: join(outside, 'escaped', 'session.v4.jsonl') } })
      await mkdir(join(root, 'proj'), { recursive: true })
      await symlink(join(outside, 'escaped'), join(root, 'proj', 'linked'))
      f.stored.set('linked', { header: { id: 'linked', cwd: '/w' }, location: { kind: 'jsonl', path: join(root, 'proj', 'linked', 'session.v4.jsonl') } })
      f.stored.set('mismatch', { header: { id: 'someone-else', cwd: '/w' }, location: { kind: 'jsonl', path: join(nested, 'session.v4.jsonl') } })
      f.stored.set('odd-file', { header: { id: 'odd-file', cwd: '/w' }, location: { kind: 'jsonl', path: join(nested, 'notes.txt') } })
      const deleter = sessionDeleter(f.deps)
      for (const id of ['nested', 'escaped', 'linked', 'mismatch']) {
        expect((await deleter.deleteSession(id)).kept[0]).toMatchObject({ sessionId: id, reason: 'failed' })
      }
      expect((await deleter.deleteSession('odd-file')).kept[0]).toMatchObject({ reason: 'unsupported-storage' })
      expect(await exists(nested)).toBe(true)
      expect(await exists(join(outside, 'escaped', 'session.v4.jsonl'))).toBe(true)
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('refuses a store without a JSONL root, subagent sessions, and unknown ids', async () => {
    const f = fixture()
    await store(f, { id: 'child', cwd: '/w', parentSession: 'parent', origin: 'subagent' })
    await store(f, { id: 'plain', cwd: '/w' })
    const deleter = sessionDeleter(f.deps)
    expect((await deleter.deleteSession('child')).kept).toEqual([{ sessionId: 'child', reason: 'subagent' }])
    expect((await deleter.deleteSession('missing')).kept).toEqual([{ sessionId: 'missing', reason: 'not-found' }])
    const noRoot = sessionDeleter({ ...f.deps, persistence: { ...f.deps.persistence, config: {} } })
    expect((await noRoot.deleteSession('plain')).kept).toEqual([{ sessionId: 'plain', reason: 'unsupported-storage' }])
  })

  it('deletes a stored session that has nothing on disk yet', async () => {
    const f = fixture()
    f.stored.set('pending', { header: { id: 'pending', cwd: '/w' } })
    workspace(f, 'ws', ['pending'])
    expect(await sessionDeleter(f.deps).deleteSession('pending')).toEqual({ deleted: ['pending'], kept: [] })
    expect(f.workspaces.get('ws')?.sessionIds).toEqual([])
  })

  it('reports an unexpected failure', async () => {
    const f = fixture()
    await store(f, { id: 'broken', cwd: '/w' })
    const deleter = sessionDeleter({ ...f.deps, activity: async () => { throw new Error('provider exploded') } })
    expect((await deleter.deleteSession('broken')).kept).toEqual([{ sessionId: 'broken', reason: 'failed', detail: 'provider exploded' }])
  })
})

describe('deleteWorkspace', () => {
  it('deletes every session, then the workspace', async () => {
    const f = fixture()
    await store(f, { id: 'a', cwd: '/w' })
    await store(f, { id: 'b', cwd: '/w' })
    await store(f, { id: 'a-child', cwd: '/w', parentSession: 'a', origin: 'subagent' })
    workspace(f, 'ws', ['a', 'a-child', 'b', 'gone'])
    expect(await sessionDeleter(f.deps).deleteWorkspace('ws')).toEqual({ deleted: ['a', 'a-child', 'b'], kept: [], workspaceDeleted: true })
    expect(f.workspaces.has('ws')).toBe(false)
    expect(await readdir(join(root, 'proj'))).toEqual([])
  })

  it('keeps the workspace when a session is kept', async () => {
    const f = fixture()
    await store(f, { id: 'a', cwd: '/w' })
    const busy = await store(f, { id: 'busy', cwd: '/w' })
    f.activity.set('busy', [{ kind: 'turn' }])
    workspace(f, 'ws', ['a', 'busy'])
    expect(await sessionDeleter(f.deps).deleteWorkspace('ws'))
      .toEqual({ deleted: ['a'], kept: [{ sessionId: 'busy', reason: 'running', detail: 'turn' }], workspaceDeleted: false })
    expect(f.workspaces.get('ws')?.sessionIds).toEqual(['busy'])
    expect(await exists(busy)).toBe(true)
  })

  it('returns nothing for an unknown workspace', async () => {
    expect(await sessionDeleter(fixture().deps).deleteWorkspace('missing')).toBeUndefined()
  })
})
