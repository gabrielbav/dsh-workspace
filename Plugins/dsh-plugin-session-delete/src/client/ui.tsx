/** The row button, the confirmation dialog, and the watcher that leaves a deleted open conversation. */
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { Button, IconTrashOutlineRegular, Modal, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Capabilities, DeleteReport, KeptSession } from '../shared.ts'
import type { SessionRowProps, Translate } from './dsh.ts'
import type { SessionDeleteKey } from './locales.ts'
import type { SessionDeleteApi } from './rpc.ts'
import type { DeleteRequest, Store } from './store.ts'

/** Translate bound to this plugin's namespace. */
export type T = Translate<SessionDeleteKey>

/** What the components share. */
export interface Shared {
  readonly api: SessionDeleteApi
  readonly request: Store<DeleteRequest | null>
  /** Sessions this page deleted, so an open conversation can leave them. */
  readonly deleted: Store<ReadonlySet<string>>
  readonly capabilities: Store<Capabilities | null>
  /** Open a new conversation in place of a deleted one. */
  readonly leave: () => void
}

/**
 * Hover button on a Session row: opens the delete confirmation.
 * @param props Row identity, title and translate function.
 * @returns The icon button.
 */
export function RowButton({ sessionId, displayTitle, t, shared }: SessionRowProps & { t: T; shared: Shared }): ReactNode {
  return (
    <Tooltip label={t('row.delete')} side="bottom" align="end" delayMs={500} portal>
      <button
        type="button"
        className="dsh-session-delete-row"
        aria-label={t('menu.deleteSession')}
        onClick={() => { shared.request.set({ kind: 'session', sessionId, title: displayTitle || t('untitled') }) }}
      >
        <IconTrashOutlineRegular size={14} />
      </button>
    </Tooltip>
  )
}

/**
 * The `shell.overlay` entry: the open confirmation, or nothing.
 * @param props Translate function and shared state.
 * @returns The dialog, or null.
 */
export function DeleteDialog({ t, shared }: { t: T; shared: Shared }): ReactNode {
  const request = useSyncExternalStore(shared.request.subscribe, shared.request.get)
  if (request === null) return null
  const key = request.kind === 'session' ? `s:${request.sessionId}` : `w:${request.workspaceId}`
  return <DeleteForm key={key} request={request} t={t} shared={shared} />
}

function keptLine(kept: KeptSession, t: T): string {
  return t(`reason.${kept.reason}`, { detail: kept.detail ?? '' })
}

function DeleteForm({ request, t, shared }: { request: DeleteRequest; t: T; shared: Shared }): ReactNode {
  const capabilities = useSyncExternalStore(shared.capabilities.subscribe, shared.capabilities.get)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [report, setReport] = useState<DeleteReport | null>(null)
  const close = (): void => { if (!pending) shared.request.set(null) }
  const confirm = (): void => {
    setPending(true)
    setError(null)
    const call = request.kind === 'session' ? shared.api.deleteSession(request.sessionId) : shared.api.deleteWorkspace(request.workspaceId)
    call.then((result) => {
      setPending(false)
      if (result.deleted.length > 0) shared.deleted.set(new Set([...shared.deleted.get(), ...result.deleted]))
      const done = request.kind === 'session' ? result.kept.length === 0 : result.workspaceDeleted === true
      if (done) shared.request.set(null)
      else setReport(result)
    }, (reason: unknown) => {
      setPending(false)
      setError(t('error', { message: reason instanceof Error ? reason.message : String(reason) }))
    })
  }
  const session = request.kind === 'session'
  const title = t(session ? 'confirm.session.title' : 'confirm.workspace.title')
  const description = t(session ? 'confirm.session.desc' : 'confirm.workspace.desc', { name: request.title })
  const footer = report === null
    ? (
        <>
          <Button variant="outline" disabled={pending} onClick={close}>{t('cancel')}</Button>
          <Button variant="outline" className="dsh-session-delete-danger" disabled={pending} onClick={confirm}>{t('confirm.delete')}</Button>
        </>
      )
    : <Button variant="outline" onClick={close}>{t('close')}</Button>
  return (
    <Modal open onClose={close} closeLabel={t('close')} tone="warning" title={title} description={description} footer={footer}>
      {capabilities?.releaseIdle === false && report === null && <p className="dsh-session-delete-note">{t('confirm.restartHint')}</p>}
      {pending && <p className="dsh-session-delete-note" role="status">{t('pending')}</p>}
      {error !== null && <p className="dsh-session-delete-error" role="alert">{error}</p>}
      {report !== null && (
        <div role="alert">
          <p className="dsh-session-delete-error">
            {session ? t('result.sessionKept') : t('result.workspaceKept', { deleted: String(report.deleted.length) })}
          </p>
          <ul className="dsh-session-delete-kept">
            {report.kept.map(kept => (
              <li key={kept.sessionId}>{session ? keptLine(kept, t) : <><code>{kept.sessionId}</code>{' '}{keptLine(kept, t)}</>}</li>
            ))}
          </ul>
        </div>
      )}
    </Modal>
  )
}

/**
 * Conversation header entry that renders nothing: when the shown Session was deleted from this page, it opens a
 * new conversation instead.
 * @param props The conversation's Session and shared state.
 * @returns null.
 */
export function LeaveDeleted({ sessionId, shared }: SessionRowProps & { shared: Shared }): ReactNode {
  const deleted = useSyncExternalStore(shared.deleted.subscribe, shared.deleted.get)
  const gone = deleted.has(sessionId)
  useEffect(() => { if (gone) shared.leave() }, [gone, shared])
  return null
}
