/**
 * The AWS settings page: the AWS account (profile and region), the uv check, and the catalog as groups of servers,
 * each group and each server with its own switch, plus a settings dialog per server.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Button, Checkbox, Input, Modal, StateDot, Switch, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { FieldView, GroupInfo, Overview, ServerState, ServerView } from '../shared.ts'
import type { Translate } from './dsh.ts'
import type { AwsKey } from './locales.ts'
import type { AwsApi } from './rpc.ts'

/** Translate bound to this plugin's namespace. */
export type T = Translate<AwsKey>

/** How often the open page refreshes server states. */
const POLL_MS = 2_000

/** The uv installer command shown when uvx is missing. */
const UV_INSTALL = 'curl -LsSf https://astral.sh/uv/install.sh | sh'

/** Regions offered in the region field; any valid region can be typed. */
const REGIONS = [
  'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2', 'ca-central-1', 'sa-east-1',
  'eu-west-1', 'eu-west-2', 'eu-west-3', 'eu-central-1', 'eu-central-2', 'eu-north-1', 'eu-south-1', 'eu-south-2',
  'ap-south-1', 'ap-southeast-1', 'ap-southeast-2', 'ap-northeast-1', 'ap-northeast-2', 'ap-northeast-3',
  'me-central-1', 'af-south-1',
]

const errorText = (t: T, reason: unknown): string => t('error', { message: reason instanceof Error ? reason.message : String(reason) })

/** Settings navigation icon: a cloud. */
export function NavIcon({ size }: { size: number }): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M7 18a4.5 4.5 0 0 1-.6-8.96A5.5 5.5 0 0 1 17 9.1 4 4 0 0 1 17 18H7Z" />
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

function dotOf(state: ServerState): 'done' | 'warning' | 'ongoing' | 'error' | 'idle' {
  switch (state.kind) {
    case 'connected': return 'done'
    case 'connecting': return 'ongoing'
    case 'needs-setup':
    case 'needs-uv': return 'warning'
    case 'error': return 'error'
    default: return 'idle'
  }
}

function Status({ server, t }: { server: ServerView; t: T }): ReactNode {
  const { state } = server
  let label: string
  let detail: string | undefined
  switch (state.kind) {
    case 'connected': label = state.toolCount > 0 ? t('state.connectedTools', { count: String(state.toolCount) }) : t('state.connected'); break
    case 'connecting': label = t('state.connecting'); detail = state.detail; break
    case 'needs-setup': label = t('state.needsSetup', { missing: state.missing.join(', ') }); break
    case 'needs-uv': label = t('state.needsUv'); break
    case 'error': label = t('state.error'); detail = state.message; break
    default: label = t('state.off')
  }
  return (
    <span className="dsh-aws-status">
      <StateDot state={dotOf(state)} />
      <span className="dsh-aws-status-text">
        <span>{label}</span>
        {detail !== undefined && <span className="dsh-aws-status-error" title={detail}>{detail}</span>}
      </span>
    </span>
  )
}

/**
 * The `settings.section` entry.
 * @param props Translate function and the Host endpoints.
 * @returns The page.
 */
export function AwsSection({ t, api }: { t: T; api: AwsApi }): ReactNode {
  const [overview, setOverview] = useState<Overview | null>(null)
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<Readonly<Record<string, boolean>>>({})
  const [editing, setEditing] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try { setOverview(await api.list()) }
    catch (reason) { setError(errorText(t, reason)) }
  }, [api, t])
  useEffect(() => {
    void refresh()
    const timer = setInterval(() => { void refresh() }, POLL_MS)
    return () => { clearInterval(timer) }
  }, [refresh])

  const run = (key: string, operation: () => Promise<unknown>): void => {
    setBusy(current => ({ ...current, [key]: true }))
    setError(null)
    operation().catch((reason: unknown) => { setError(errorText(t, reason)) }).finally(() => {
      setBusy(current => ({ ...current, [key]: false }))
      void refresh()
    })
  }

  const visible = useMemo(() => {
    const servers = overview?.servers ?? []
    const needle = query.trim().toLowerCase()
    if (needle === '') return servers
    return servers.filter(server => `${server.name} ${server.description} ${server.package ?? ''}`.toLowerCase().includes(needle))
  }, [overview, query])

  if (overview === null) {
    return <div className="dsh-aws">{error !== null ? <p className="dsh-aws-error" role="alert">{error}</p> : <p className="dsh-aws-intro">…</p>}</div>
  }
  const editingServer = editing === null ? undefined : overview.servers.find(server => server.id === editing)

  return (
    <div className="dsh-aws">
      <p className="dsh-aws-intro">{t('intro')}</p>
      <UvBanner t={t} overview={overview} pending={busy.uv === true} onRecheck={() => { run('uv', refresh) }} />
      <AccountCard t={t} api={api} overview={overview} onSaved={() => { void refresh() }} />
      <div className="dsh-aws-search">
        <Input icon={<SearchIcon />} value={query} placeholder={t('search')} aria-label={t('search')} onChange={(event) => { setQuery(event.target.value) }} />
      </div>
      {error !== null && <p className="dsh-aws-error" role="alert">{error}</p>}
      {visible.length === 0 && <p className="dsh-aws-empty">{t('empty', { query })}</p>}
      {overview.groups.map((group) => {
        const all = overview.servers.filter(server => server.group === group.id)
        const shown = visible.filter(server => server.group === group.id)
        if (shown.length === 0) return null
        return (
          <GroupCard
            key={group.id}
            t={t}
            group={group}
            servers={all}
            shown={shown}
            busy={busy}
            onToggleGroup={(enabled) => { run(`group:${group.id}`, () => api.setEnabled(all.map(server => server.id), enabled)) }}
            onToggle={(server, enabled) => { run(server.id, () => api.setEnabled([server.id], enabled)) }}
            onSettings={(server) => { setEditing(server.id) }}
            onRestart={(server) => { run(server.id, () => api.restart(server.id)) }}
          />
        )
      })}
      {editingServer !== undefined && (
        <SettingsDialog t={t} api={api} server={editingServer} profiles={overview.profiles} onClose={() => { setEditing(null); void refresh() }} />
      )}
    </div>
  )
}

function UvBanner({ t, overview, pending, onRecheck }: { t: T; overview: Overview; pending: boolean; onRecheck: () => void }): ReactNode {
  const needsUv = overview.servers.some(server => server.enabled && server.runtime !== 'remote')
  if (overview.uv.found) {
    return overview.uv.version === undefined ? null : <p className="dsh-aws-meta">{t('uv.found', { version: overview.uv.version })}</p>
  }
  return (
    <div className={needsUv ? 'dsh-aws-banner dsh-aws-banner-warning' : 'dsh-aws-banner'} role={needsUv ? 'alert' : undefined}>
      <p>{t('uv.missing')}</p>
      <code>{UV_INSTALL}</code>
      <div><Button size="sm" variant="outline" disabled={pending} onClick={onRecheck}>{t('uv.recheck')}</Button></div>
    </div>
  )
}

function AccountCard({ t, api, overview, onSaved }: { t: T; api: AwsApi; overview: Overview; onSaved: () => void }): ReactNode {
  const [profile, setProfile] = useState(overview.profile)
  const [region, setRegion] = useState(overview.region)
  const [pending, setPending] = useState(false)
  const [message, setMessage] = useState<{ readonly error: boolean; readonly text: string } | null>(null)
  const changed = profile.trim() !== overview.profile || region.trim() !== overview.region
  const save = (): void => {
    if (!changed || pending) return
    setPending(true)
    setMessage(null)
    api.setGlobal(profile.trim(), region.trim())
      .then(() => { setMessage({ error: false, text: t('account.saved') }); onSaved() })
      .catch((reason: unknown) => { setMessage({ error: true, text: errorText(t, reason) }) })
      .finally(() => { setPending(false) })
  }
  return (
    <section className="dsh-aws-card">
      <div className="dsh-aws-card-head">
        <div>
          <h3 className="dsh-aws-title">{t('account.title')}</h3>
          <p className="dsh-aws-sub">{t('account.desc')}</p>
        </div>
      </div>
      <div className="dsh-aws-account">
        <label className="dsh-aws-field">
          {t('account.profile')}
          <Input list="dsh-aws-profiles" value={profile} placeholder={t('default')} spellCheck={false} autoComplete="off"
            onChange={(event) => { setProfile(event.target.value) }} onKeyDown={(event) => { if (event.key === 'Enter') save() }} />
          <datalist id="dsh-aws-profiles">{overview.profiles.map(name => <option key={name} value={name} />)}</datalist>
        </label>
        <label className="dsh-aws-field">
          {t('account.region')}
          <Input list="dsh-aws-regions" value={region} placeholder={t('default')} spellCheck={false} autoComplete="off"
            onChange={(event) => { setRegion(event.target.value) }} onKeyDown={(event) => { if (event.key === 'Enter') save() }} />
          <datalist id="dsh-aws-regions">{REGIONS.map(name => <option key={name} value={name} />)}</datalist>
        </label>
        <Button variant="outline" disabled={!changed || pending} onClick={save}>{pending ? t('account.saving') : t('account.save')}</Button>
      </div>
      {message !== null && <p className={message.error ? 'dsh-aws-error' : 'dsh-aws-meta'} role={message.error ? 'alert' : 'status'}>{message.text}</p>}
    </section>
  )
}

function GroupCard(props: {
  t: T
  group: GroupInfo
  servers: readonly ServerView[]
  shown: readonly ServerView[]
  busy: Readonly<Record<string, boolean>>
  onToggleGroup: (enabled: boolean) => void
  onToggle: (server: ServerView, enabled: boolean) => void
  onSettings: (server: ServerView) => void
  onRestart: (server: ServerView) => void
}): ReactNode {
  const { t, group, servers, shown, busy } = props
  const on = servers.filter(server => server.enabled).length
  const groupBusy = busy[`group:${group.id}`] === true
  return (
    <section className="dsh-aws-card">
      <div className="dsh-aws-card-head">
        <div>
          <h3 className="dsh-aws-title">{group.title}</h3>
          <p className="dsh-aws-sub">{group.description}</p>
        </div>
        <span className="dsh-aws-group-switch">
          <span className="dsh-aws-meta">{t('group.count', { on: String(on), total: String(servers.length) })}</span>
          <Switch checked={on === servers.length} disabled={groupBusy} label={t('group.toggle', { name: group.title })}
            onChange={(next) => { props.onToggleGroup(next) }} />
        </span>
      </div>
      <ul className="dsh-aws-servers">
        {shown.map(server => (
          <li key={server.id} className="dsh-aws-server">
            <div className="dsh-aws-server-main">
              <span className="dsh-aws-server-name">
                {server.name}
                <Tag tone="quiet">{t(server.runtime === 'remote' ? 'runtime.remote' : server.runtime === 'proxy' ? 'runtime.proxy' : 'runtime.local')}</Tag>
                {server.allowWrite && <Tag tone="warning">{t('tag.write')}</Tag>}
              </span>
              <span className="dsh-aws-sub">{server.description}</span>
              {server.note !== undefined && <span className="dsh-aws-note">{server.note}</span>}
              {server.enabled && <Status server={server} t={t} />}
            </div>
            <div className="dsh-aws-server-actions">
              <a className="dsh-aws-link" href={server.docsUrl} target="_blank" rel="noreferrer">{t('server.docs')}</a>
              {server.state.kind === 'error' && (
                <Button size="sm" variant="ghost" disabled={busy[server.id] === true} onClick={() => { props.onRestart(server) }}>{t('action.restart')}</Button>
              )}
              <Button size="sm" variant="outline" onClick={() => { props.onSettings(server) }}>{t('server.settings')}</Button>
              <Switch checked={server.enabled} disabled={busy[server.id] === true || groupBusy} label={t('server.toggle', { name: server.name })}
                onChange={(next) => { props.onToggle(server, next) }} />
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}

function FieldInput({ field, value, stored, cleared, onChange, onClear, t }: {
  field: FieldView
  value: string
  stored: boolean
  cleared: boolean
  onChange: (value: string) => void
  onClear: () => void
  t: T
}): ReactNode {
  if (field.kind === 'boolean') {
    return <Checkbox checked={value === 'true'} label={field.label} onChange={(next) => { onChange(next ? 'true' : '') }} />
  }
  return (
    <label className="dsh-aws-field">
      <span>{field.label}{field.required === true ? ' *' : ''}</span>
      {field.kind === 'select'
        ? (
          <select className="dsh-aws-select" value={value} onChange={(event) => { onChange(event.target.value) }}>
            <option value="">{t('default')}</option>
            {(field.options ?? []).map(option => <option key={option} value={option}>{option}</option>)}
          </select>
        )
        : (
          <Input
            type={field.kind === 'secret' ? 'password' : 'text'}
            autoComplete="off"
            spellCheck={false}
            placeholder={field.kind === 'secret' && stored && !cleared ? t('settings.secretStored') : field.placeholder}
            value={value}
            onChange={(event) => { onChange(event.target.value) }}
          />
        )}
      {field.help !== undefined && <span className="dsh-aws-hint">{field.help}</span>}
      {field.kind === 'secret' && stored && (cleared
        ? <span className="dsh-aws-hint">{t('settings.secretCleared')}</span>
        : <button type="button" className="dsh-aws-link dsh-aws-link-button" onClick={onClear}>{t('settings.secretClear')}</button>)}
    </label>
  )
}

function SettingsDialog({ t, api, server, profiles, onClose }: { t: T; api: AwsApi; server: ServerView; profiles: readonly string[]; onClose: () => void }): ReactNode {
  const [values, setValues] = useState<Record<string, string>>({ ...server.values })
  const [secrets, setSecrets] = useState<Record<string, string>>({})
  const [cleared, setCleared] = useState<ReadonlySet<string>>(new Set())
  const [allowWrite, setAllowWrite] = useState(server.allowWrite)
  const [allowSensitive, setAllowSensitive] = useState(server.allowSensitive)
  const [profile, setProfile] = useState(server.profile)
  const [region, setRegion] = useState(server.region)
  const [extraEnv, setExtraEnv] = useState(server.extraEnv)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const local = server.runtime !== 'remote'

  const save = (): void => {
    if (pending) return
    const secretPayload: Record<string, string> = {}
    for (const field of server.fields) {
      if (field.kind !== 'secret') continue
      const typed = secrets[field.id] ?? ''
      if (typed !== '') secretPayload[field.id] = typed
      else if (cleared.has(field.id)) secretPayload[field.id] = ''
    }
    setPending(true)
    setError(null)
    api.configure({ id: server.id, values, secrets: secretPayload, allowWrite, allowSensitive, profile: profile.trim(), region: region.trim(), extraEnv })
      .then(onClose)
      .catch((reason: unknown) => { setError(errorText(t, reason)) })
      .finally(() => { setPending(false) })
  }
  const close = (): void => { if (!pending) onClose() }

  return (
    <Modal
      open
      closeLabel={t('close')}
      onClose={close}
      title={t('settings.title', { name: server.name })}
      description={server.description}
      footer={(
        <>
          <Button variant="outline" disabled={pending} onClick={close}>{t('cancel')}</Button>
          {local && <Button variant="primary" disabled={pending} onClick={save}>{pending ? t('settings.saving') : t('settings.save')}</Button>}
        </>
      )}
    >
      <div className="dsh-aws-form">
        <p className="dsh-aws-meta">
          {server.package !== undefined ? t('settings.runs', { package: server.package }) : t('settings.remote')}
          {' · '}
          <a className="dsh-aws-link" href={server.docsUrl} target="_blank" rel="noreferrer">{t('server.docs')}</a>
        </p>
        {server.requireAny !== undefined && (
          <p className="dsh-aws-hint">{t('settings.requireAny', { fields: server.requireAny.map(id => server.fields.find(field => field.id === id)?.label ?? id).join(', ') })}</p>
        )}
        {server.fields.map(field => (
          <FieldInput
            key={field.id}
            t={t}
            field={field}
            value={field.kind === 'secret' ? secrets[field.id] ?? '' : values[field.id] ?? ''}
            stored={server.secretsSet.includes(field.id)}
            cleared={cleared.has(field.id)}
            onChange={(value) => {
              if (field.kind === 'secret') setSecrets(current => ({ ...current, [field.id]: value }))
              else setValues(current => ({ ...current, [field.id]: value }))
            }}
            onClear={() => { setCleared(current => new Set([...current, field.id])) }}
          />
        ))}
        {(server.permissions.write || server.permissions.sensitive) && (
          <fieldset className="dsh-aws-fieldset">
            <legend>{t('settings.permissions')}</legend>
            <p className="dsh-aws-hint">{t('settings.readOnly')}</p>
            {server.permissions.write && <Checkbox checked={allowWrite} label={t('settings.allowWrite')} onChange={setAllowWrite} />}
            {server.permissions.sensitive && <Checkbox checked={allowSensitive} label={t('settings.allowSensitive')} onChange={setAllowSensitive} />}
          </fieldset>
        )}
        {server.aws && local && (
          <fieldset className="dsh-aws-fieldset">
            <legend>{t('settings.account')}</legend>
            <p className="dsh-aws-hint">{t('settings.accountHint')}</p>
            <div className="dsh-aws-account">
              <label className="dsh-aws-field">
                {t('account.profile')}
                <Input list="dsh-aws-profiles-server" value={profile} placeholder={t('default')} spellCheck={false} autoComplete="off" onChange={(event) => { setProfile(event.target.value) }} />
                <datalist id="dsh-aws-profiles-server">{profiles.map(name => <option key={name} value={name} />)}</datalist>
              </label>
              <label className="dsh-aws-field">
                {t('account.region')}
                <Input list="dsh-aws-regions" value={region} placeholder={t('default')} spellCheck={false} autoComplete="off" onChange={(event) => { setRegion(event.target.value) }} />
              </label>
            </div>
          </fieldset>
        )}
        {local && (
          <label className="dsh-aws-field">
            {t('settings.advanced')}
            <textarea className="dsh-aws-textarea" rows={3} spellCheck={false} value={extraEnv} placeholder="NAME=value" onChange={(event) => { setExtraEnv(event.target.value) }} />
            <span className="dsh-aws-hint">{t('settings.advancedHint')}</span>
          </label>
        )}
      </div>
      {error !== null && <p className="dsh-aws-error" role="alert">{error}</p>}
    </Modal>
  )
}
