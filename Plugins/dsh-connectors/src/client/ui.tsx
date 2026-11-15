/**
 * The Connectors settings page: search, the Add menu, the connectors table, and the token, custom connector, package,
 * disconnect and remove dialogs.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Button, Input, Modal, StateDot, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Capabilities, ConnectorState, ConnectorView, PackageCheck, PackageInstall } from '../shared.ts'
import type { Translate } from './dsh.ts'
import type { ConnectorsKey } from './locales.ts'
import type { ConnectorsApi } from './rpc.ts'

/** Translate bound to this plugin's namespace. */
export type T = Translate<ConnectorsKey>

/** How often the open page refreshes connector states. */
const POLL_MS = 2_000

const errorText = (t: T, reason: unknown): string => t('error', { message: reason instanceof Error ? reason.message : String(reason) })

/** Settings navigation icon: a plug. */
export function NavIcon({ size }: { size: number }): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M9 3v4M15 3v4M7 7h10v4a5 5 0 0 1-10 0V7ZM12 16v5" />
    </svg>
  )
}

function SearchIcon(): ReactNode {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />
    </svg>
  )
}

function PlusIcon(): ReactNode {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}

/** A connector's icon: its SVG used as a mask over the current text color, so it follows the theme. */
function Logo({ icon }: { icon: string | undefined }): ReactNode {
  if (icon === undefined) return <NavIcon size={16} />
  // An SVG loaded as an image renders only with its namespace; definitions may leave it out.
  const svg = /\sxmlns=/.test(icon) ? icon : icon.replace(/^<svg\b/, '<svg xmlns="http://www.w3.org/2000/svg"')
  const url = `url("data:image/svg+xml,${encodeURIComponent(svg)}")`
  return <span className="dsh-connectors-mask" style={{ maskImage: url, WebkitMaskImage: url }} aria-hidden />
}

function dotOf(state: ConnectorState): 'done' | 'warning' | 'ongoing' | 'error' | 'idle' {
  switch (state.kind) {
    case 'connected': return 'done'
    case 'authorizing':
    case 'connecting': return 'ongoing'
    case 'error': return 'error'
    default: return 'idle'
  }
}

function Status({ connector, t }: { connector: ConnectorView; t: T }): ReactNode {
  const { state } = connector
  let label: string
  let detail: ReactNode = null
  switch (state.kind) {
    case 'connected':
      label = state.toolCount > 0 ? t('state.connectedTools', { count: String(state.toolCount) }) : t('state.connected')
      break
    case 'authorizing': label = t('state.authorizing'); break
    case 'connecting':
      label = t('state.connecting')
      if (state.detail !== undefined) detail = <span className="dsh-connectors-status-error" title={state.detail}>{state.detail}</span>
      break
    case 'error':
      label = t('state.error')
      detail = <span className="dsh-connectors-status-error" title={state.message}>{state.message}</span>
      break
    default:
      label = t(connector.setup === undefined ? 'state.disconnected' : 'state.setup')
      if (connector.setup !== undefined) detail = <span className="dsh-connectors-status-detail">{connector.setup.reason}</span>
  }
  const facts = [
    connector.account === undefined ? undefined : t('account', { account: connector.account }),
    connector.via === undefined || connector.auth.length < 2 ? undefined : t(connector.via === 'oauth' ? 'via.oauth' : 'via.token'),
  ].filter(item => item !== undefined).join(' · ')
  return (
    <div className="dsh-connectors-status">
      <StateDot state={dotOf(state)} />
      <span className="dsh-connectors-status-text">
        <span>{label}</span>
        {facts !== '' && <span className="dsh-connectors-status-detail">{facts}</span>}
        {detail}
      </span>
    </div>
  )
}

/** A modal the page shows; only one at a time. */
type Dialog =
  | { readonly kind: 'token'; readonly connector: ConnectorView }
  | { readonly kind: 'disconnect'; readonly connector: ConnectorView }
  | { readonly kind: 'remove'; readonly connector: ConnectorView }
  | { readonly kind: 'custom' }
  | { readonly kind: 'package' }

/**
 * The `settings.section` entry.
 * @param props Translate function and the Host endpoints.
 * @returns The page.
 */
export function ConnectorsSection({ t, api }: { t: T; api: ConnectorsApi }): ReactNode {
  const [connectors, setConnectors] = useState<readonly ConnectorView[] | null>(null)
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null)
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<Readonly<Record<string, boolean>>>({})
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [menu, setMenu] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  const refresh = useCallback(async () => {
    try { setConnectors(await api.list()) }
    catch (reason) { setError(errorText(t, reason)) }
  }, [api, t])
  useEffect(() => {
    void refresh()
    api.capabilities().then(setCapabilities, () => { setCapabilities({ packages: false }) })
    const timer = setInterval(() => { void refresh() }, POLL_MS)
    return () => { clearInterval(timer) }
  }, [api, refresh])
  useEffect(() => {
    if (!menu) return
    const close = (event: PointerEvent): void => { if (!menuRef.current?.contains(event.target as Node)) setMenu(false) }
    const key = (event: KeyboardEvent): void => { if (event.key === 'Escape') setMenu(false) }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', key)
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', key) }
  }, [menu])

  const run = (id: string, operation: () => Promise<unknown>): void => {
    setBusy(current => ({ ...current, [id]: true }))
    setError(null)
    operation().catch((reason: unknown) => { setError(errorText(t, reason)) }).finally(() => {
      setBusy(current => ({ ...current, [id]: false }))
      void refresh()
    })
  }
  const closeDialog = (): void => { setDialog(null); void refresh() }

  /** Opens the window inside the click, before any await, so the browser does not treat it as an unrequested pop-up. */
  const connectOAuth = (connector: ConnectorView): void => {
    const popup = window.open('about:blank', '_blank')
    if (popup === null) { setError(t('popupBlocked')); return }
    run(connector.id, async () => {
      try {
        const { url } = await api.beginOAuth(connector.id)
        // The popup shares this page's origin until it navigates, so only a web page may load in it.
        const target = new URL(url)
        if (target.protocol !== 'https:' && !(target.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname))) {
          throw new Error(`refusing to open ${target.protocol} URL`)
        }
        popup.opener = null
        popup.location.href = url
      } catch (reason) {
        popup.close()
        throw reason
      }
    })
  }
  const connect = (connector: ConnectorView): void => {
    if (connector.auth[0] === 'oauth') connectOAuth(connector)
    else setDialog({ kind: 'token', connector })
  }

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (connectors === null || needle === '') return connectors ?? []
    return connectors.filter(item => `${item.name} ${item.description}`.toLowerCase().includes(needle))
  }, [connectors, query])

  const actions = (connector: ConnectorView): ReactNode => {
    const pending = busy[connector.id] === true
    const both = connector.auth.length > 1
    const buttons: ReactNode[] = []
    switch (connector.state.kind) {
      case 'disconnected':
        if (connector.setup !== undefined) {
          if (connector.setup.helpUrl !== undefined) buttons.push(<a key="setup" className="dsh-connectors-link" href={connector.setup.helpUrl} target="_blank" rel="noreferrer">{t('action.howToSetup')}</a>)
          break
        }
        buttons.push(<Button key="connect" size="sm" variant="outline" disabled={pending} onClick={() => { connect(connector) }}>{t('action.connect')}</Button>)
        if (both) buttons.push(<Button key="token" size="sm" variant="outline" disabled={pending} onClick={() => { setDialog({ kind: 'token', connector }) }}>{t('action.useToken')}</Button>)
        break
      case 'authorizing':
        buttons.push(<Button key="cancel" size="sm" variant="outline" onClick={() => { run(connector.id, () => api.cancelOAuth(connector.id)) }}>{t('action.cancel')}</Button>)
        break
      default:
        if (connector.state.kind === 'error') buttons.push(<Button key="retry" size="sm" variant="outline" disabled={pending} onClick={() => { connect(connector) }}>{t('action.retry')}</Button>)
        if (connector.setupUrl !== undefined && connector.via === 'oauth') {
          const setupUrl = connector.setupUrl
          buttons.push(<Button key="setup" size="sm" variant="outline" onClick={() => { window.open(setupUrl, '_blank', 'noopener') }}>{t('action.setup')}</Button>)
        }
        if (connector.registered) buttons.push(<Button key="reconnect" size="sm" variant="outline" disabled={pending} onClick={() => { run(connector.id, () => api.reconnect(connector.id)) }}>{t('action.reconnect')}</Button>)
        buttons.push(<Button key="disconnect" size="sm" variant="outline" className="dsh-connectors-danger" disabled={pending} onClick={() => { setDialog({ kind: 'disconnect', connector }) }}>{t('action.disconnect')}</Button>)
    }
    if (connector.custom === true && connector.state.kind !== 'authorizing') {
      buttons.push(<Button key="remove" size="sm" variant="outline" className="dsh-connectors-danger" disabled={pending} onClick={() => { setDialog({ kind: 'remove', connector }) }}>{t('action.remove')}</Button>)
    }
    return <span className="dsh-connectors-actions">{buttons}</span>
  }

  return (
    <div className="dsh-connectors">
      <p className="dsh-connectors-intro">{t('intro')}</p>
      <div className="dsh-connectors-toolbar">
        <Input
          className="dsh-connectors-search"
          icon={<SearchIcon />}
          type="search"
          placeholder={t('search')}
          aria-label={t('search')}
          value={query}
          onChange={(event) => { setQuery(event.target.value) }}
        />
        <div className="dsh-connectors-add" ref={menuRef}>
          <Button variant="primary" size="sm" icon={<PlusIcon />} aria-haspopup="menu" aria-expanded={menu} onClick={() => { setMenu(open => !open) }}>{t('add')}</Button>
          {menu && (
            <div className="dsh-connectors-menu" role="menu">
              <button type="button" role="menuitem" onClick={() => { setMenu(false); setDialog({ kind: 'custom' }) }}>
                <span>{t('add.custom')}</span><span className="dsh-connectors-sub">{t('add.customDesc')}</span>
              </button>
              {capabilities?.packages === true && (
                <button type="button" role="menuitem" onClick={() => { setMenu(false); setDialog({ kind: 'package' }) }}>
                  <span>{t('add.package')}</span><span className="dsh-connectors-sub">{t('add.packageDesc')}</span>
                </button>
              )}
            </div>
          )}
        </div>
      </div>
      {error !== null && <p className="dsh-connectors-error" role="alert">{error}</p>}
      <table className="dsh-connectors-table">
        <colgroup>
          <col />
          <col className="dsh-connectors-col-type" />
          <col className="dsh-connectors-col-auth" />
          <col className="dsh-connectors-col-status" />
          <col className="dsh-connectors-col-actions" />
        </colgroup>
        <thead>
          <tr>
            <th scope="col">{t('col.connector')}</th>
            <th scope="col">{t('col.type')}</th>
            <th scope="col">{t('col.auth')}</th>
            <th scope="col">{t('col.status')}</th>
            <th scope="col" aria-label={t('col.actions')} />
          </tr>
        </thead>
        <tbody>
          {visible.map(connector => (
            <tr key={connector.id}>
              <td>
                <div className="dsh-connectors-name">
                  <span className="dsh-connectors-logo"><Logo icon={connector.icon} /></span>
                  <span>
                    <div className="dsh-connectors-title">{connector.name}</div>
                    <div className="dsh-connectors-sub" title={connector.description}>{connector.description}</div>
                  </span>
                </div>
              </td>
              <td><Tag tone="neutral">{t('type.mcp')}</Tag></td>
              <td>
                <span className="dsh-connectors-tags">
                  {(connector.auth.length === 0 && connector.setup !== undefined ? ['oauth' as const] : connector.auth)
                    .map(kind => <Tag key={kind} tone="outline">{t(kind === 'oauth' ? 'auth.oauth' : 'auth.token')}</Tag>)}
                </span>
              </td>
              <td><Status connector={connector} t={t} /></td>
              <td>{actions(connector)}</td>
            </tr>
          ))}
          {connectors !== null && visible.length === 0 && (
            <tr><td className="dsh-connectors-empty" colSpan={5}>{t('empty', { query: query.trim() })}</td></tr>
          )}
        </tbody>
      </table>
      {dialog?.kind === 'token' && <TokenDialog key={dialog.connector.id} connector={dialog.connector} t={t} api={api} onClose={closeDialog} />}
      {dialog?.kind === 'custom' && <CustomDialog t={t} api={api} onClose={closeDialog} />}
      {dialog?.kind === 'package' && <PackageDialog t={t} api={api} onClose={closeDialog} />}
      {(dialog?.kind === 'disconnect' || dialog?.kind === 'remove') && (
        <Confirm
          t={t}
          title={t(dialog.kind === 'remove' ? 'remove.title' : 'disconnect.title', { name: dialog.connector.name })}
          description={t(dialog.kind === 'remove' ? 'remove.desc' : 'disconnect.desc', { name: dialog.connector.name })}
          confirm={t(dialog.kind === 'remove' ? 'action.remove' : 'action.disconnect')}
          onCancel={() => { setDialog(null) }}
          onConfirm={() => {
            const { connector, kind } = dialog
            setDialog(null)
            run(connector.id, () => kind === 'remove' ? api.removeCustom(connector.id) : api.disconnect(connector.id))
          }}
        />
      )}
    </div>
  )
}

function Confirm({ t, title, description, confirm, onCancel, onConfirm }: {
  t: T; title: string; description: string; confirm: string; onCancel: () => void; onConfirm: () => void
}): ReactNode {
  return (
    <Modal
      open
      tone="warning"
      closeLabel={t('close')}
      onClose={onCancel}
      title={title}
      description={description}
      footer={(
        <>
          <Button variant="outline" onClick={onCancel}>{t('cancel')}</Button>
          <Button variant="outline" className="dsh-connectors-danger" onClick={onConfirm}>{confirm}</Button>
        </>
      )}
    />
  )
}

/** Shared state of a dialog with one submit action. */
function useSubmit(t: T) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = <R,>(operation: () => Promise<R>, done: (result: R) => void): void => {
    setPending(true)
    setError(null)
    operation().then((result) => { setPending(false); done(result) }, (reason: unknown) => {
      setPending(false)
      setError(errorText(t, reason))
    })
  }
  return { pending, error, setError, submit }
}

function TokenDialog({ connector, t, api, onClose }: { connector: ConnectorView; t: T; api: ConnectorsApi; onClose: () => void }): ReactNode {
  const fields = connector.fields ?? []
  const [values, setValues] = useState<Readonly<Record<string, string>>>({})
  const { pending, error, submit } = useSubmit(t)
  const complete = fields.every(field => (values[field.id] ?? '').trim() !== '')
  const save = (): void => { if (complete && !pending) submit(() => api.setToken(connector.id, values), onClose) }
  const close = (): void => { if (!pending) onClose() }
  return (
    <Modal
      open
      closeLabel={t('close')}
      onClose={close}
      title={t('token.title', { name: connector.name })}
      description={t('token.desc', { name: connector.name })}
      footer={(
        <>
          <Button variant="outline" disabled={pending} onClick={close}>{t('cancel')}</Button>
          <Button variant="primary" disabled={pending || !complete} onClick={save}>{pending ? t('token.saving') : t('token.save')}</Button>
        </>
      )}
    >
      {connector.tokenUrl !== undefined && (
        <p className="dsh-connectors-note">
          <a href={connector.tokenUrl} target="_blank" rel="noreferrer">{t('token.create', { name: connector.name })}</a>
        </p>
      )}
      <div className="dsh-connectors-form">
        {fields.map(field => (
          <label key={field.id} className="dsh-connectors-field">
            {field.label}
            <Input
              type={field.secret ? 'password' : 'text'}
              autoComplete="off"
              spellCheck={false}
              placeholder={field.placeholder}
              value={values[field.id] ?? ''}
              onChange={(event) => { const value = event.target.value; setValues(current => ({ ...current, [field.id]: value })) }}
              onKeyDown={(event) => { if (event.key === 'Enter') save() }}
            />
          </label>
        ))}
      </div>
      {error !== null && <p className="dsh-connectors-error" role="alert">{error}</p>}
    </Modal>
  )
}

function CustomDialog({ t, api, onClose }: { t: T; api: ConnectorsApi; onClose: () => void }): ReactNode {
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const { pending, error, submit } = useSubmit(t)
  const complete = name.trim() !== '' && url.trim() !== ''
  const add = (): void => { if (complete && !pending) submit(() => api.addCustom(name, url), onClose) }
  const close = (): void => { if (!pending) onClose() }
  return (
    <Modal
      open
      closeLabel={t('close')}
      onClose={close}
      title={t('custom.title')}
      description={t('custom.desc')}
      footer={(
        <>
          <Button variant="outline" disabled={pending} onClick={close}>{t('cancel')}</Button>
          <Button variant="primary" disabled={pending || !complete} onClick={add}>{pending ? t('custom.adding') : t('custom.add')}</Button>
        </>
      )}
    >
      <div className="dsh-connectors-form">
        <label className="dsh-connectors-field">
          {t('custom.name')}
          <Input value={name} maxLength={60} placeholder="Linear" onChange={(event) => { setName(event.target.value) }} />
        </label>
        <label className="dsh-connectors-field">
          {t('custom.url')}
          <Input
            value={url}
            type="url"
            spellCheck={false}
            placeholder="https://mcp.example.com/mcp"
            onChange={(event) => { setUrl(event.target.value) }}
            onKeyDown={(event) => { if (event.key === 'Enter') add() }}
          />
        </label>
      </div>
      {error !== null && <p className="dsh-connectors-error" role="alert">{error}</p>}
    </Modal>
  )
}

function PackageDialog({ t, api, onClose }: { t: T; api: ConnectorsApi; onClose: () => void }): ReactNode {
  const [spec, setSpec] = useState('')
  const [checked, setChecked] = useState<Extract<PackageCheck, { ok: true }> | null>(null)
  const [outcome, setOutcome] = useState<PackageInstall | null>(null)
  const { pending, error, setError, submit } = useSubmit(t)
  const check = (): void => {
    if (spec.trim() === '' || pending) return
    setChecked(null)
    setOutcome(null)
    submit(() => api.checkPackage(spec), (result) => { if (result.ok) setChecked(result); else setError(result.reason) })
  }
  const install = (acknowledged?: string): void => {
    if (checked === null || pending) return
    submit(() => api.installPackage(checked.name, checked.version, acknowledged), setOutcome)
  }
  const close = (): void => { if (!pending) onClose() }
  const done = outcome?.status === 'installed' || outcome?.status === 'restart-required'
  const gate = outcome !== null && 'gate' in outcome ? outcome.gate : undefined
  let footer: ReactNode
  if (done) footer = <Button variant="primary" onClick={onClose}>{t('close')}</Button>
  else if (outcome?.status === 'review') {
    footer = (
      <>
        <Button variant="outline" disabled={pending} onClick={close}>{t('cancel')}</Button>
        <Button variant="outline" className="dsh-connectors-danger" disabled={pending} onClick={() => { install(outcome.gate.digest) }}>{t('package.installAnyway')}</Button>
      </>
    )
  } else if (checked !== null && outcome?.status !== 'blocked') {
    footer = (
      <>
        <Button variant="outline" disabled={pending} onClick={close}>{t('cancel')}</Button>
        <Button variant="primary" disabled={pending} onClick={() => { install() }}>{pending ? t('package.installing') : t('package.install')}</Button>
      </>
    )
  } else {
    footer = (
      <>
        <Button variant="outline" disabled={pending} onClick={close}>{t(outcome?.status === 'blocked' ? 'close' : 'cancel')}</Button>
        {outcome?.status !== 'blocked' && <Button variant="primary" disabled={pending || spec.trim() === ''} onClick={check}>{pending ? t('package.checking') : t('package.check')}</Button>}
      </>
    )
  }
  return (
    <Modal open closeLabel={t('close')} onClose={close} title={t('package.title')} description={t('package.desc')} footer={footer}>
      <label className="dsh-connectors-field">
        {t('package.spec')}
        <Input
          value={spec}
          spellCheck={false}
          disabled={pending || done}
          placeholder="@acme/dsh-connector-linear"
          onChange={(event) => { setSpec(event.target.value); setChecked(null); setOutcome(null) }}
          onKeyDown={(event) => { if (event.key === 'Enter' && checked === null) check() }}
        />
      </label>
      {checked !== null && (
        <div className="dsh-connectors-package">
          <p className="dsh-connectors-note">{t('package.found', { name: checked.name, version: checked.version, ids: checked.connectorIds.join(', ') })}</p>
          {checked.description !== undefined && <p className="dsh-connectors-sub">{checked.description}</p>}
          {!done && <p className="dsh-connectors-warning">{t('package.warning')}</p>}
        </div>
      )}
      {gate !== undefined && (
        <div className="dsh-connectors-gate" role="alert">
          <p>{gate.level === 'block' ? t('package.blocked') : t('package.review', { score: gate.score === undefined ? '–' : String(gate.score) })}</p>
          <ul>{[...gate.reasons, ...gate.findings].map(line => <li key={line}>{line}</li>)}</ul>
        </div>
      )}
      {outcome?.status === 'installed' && <p className="dsh-connectors-note" role="status">{t('package.installed')}</p>}
      {outcome?.status === 'restart-required' && <p className="dsh-connectors-note" role="status">{t('package.restart')}</p>}
      {outcome?.status === 'failed' && <p className="dsh-connectors-error" role="alert">{t('package.failed', { reason: outcome.reason })}</p>}
      {error !== null && <p className="dsh-connectors-error" role="alert">{error}</p>}
    </Modal>
  )
}
