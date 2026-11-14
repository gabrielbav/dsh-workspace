/**
 * Code plugin slot components. Each one renders nothing outside its Code
 * context, so ordinary Chat sessions look exactly as they do without the
 * plugin. Copy comes from the `dsh-code` locale namespace.
 */
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import { Button, Input, Modal, SegmentedControl, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { BrowserAction, CodeSessionView, CodeSettings, CodeSettingsView, FirewallView, TailscaleJoinView, GhAccount, IsolatedFrame, PreviewTargets, ProvisionStep, SessionOverrides, SessionOverridesView, SessionVariables, PendingWork, SelfTestReport, SessionEnvironment, WorkspaceUsage } from '../types.ts'
import type { NS } from './locales.ts'

type T = PropsLocale<typeof NS>['t']

/** Result of one Remote call, reduced for the UI. */
export type Outcome<V> = { readonly ok: true; readonly value: V } | { readonly ok: false; readonly message: string }

const row: CSSProperties = { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }
const select: CSSProperties = {
  font: 'inherit', fontSize: 13, padding: '4px 8px', borderRadius: 8, maxWidth: 260,
  border: '1px solid var(--dsw-alias-border-default, rgba(127,127,127,.35))', background: 'transparent', color: 'inherit',
}
const note: CSSProperties = { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)', padding: '2px 0' }

// ── Guided setup (conversation.input.dock) ─────────────────────────────────

/** Injected face of the setup notice. */
export interface SetupInjected {
  readonly hooks: { readonly presetIds: HostObservable<ReadonlySet<string>> }
  readonly sessionId: string
  readonly setup: (refresh: boolean) => Promise<Outcome<SelfTestReport>>
  readonly buildWorker: () => Promise<Outcome<SelfTestReport>>
  readonly prepareRemote: () => Promise<Outcome<SelfTestReport>>
}

/**
 * Failing Docker + gVisor checks above the composer of a Code mode session, with each check's remedy,
 * Check again, and Build worker image when the image is missing. Renders nothing once every check passes.
 * @param props - injected setup calls, state and translator.
 * @returns the notice, or nothing.
 */
export function SetupNotice({ usePresetIds, sessionId, setup, buildWorker, prepareRemote, t }: InjectFace<SetupInjected> & PropsLocale<typeof NS>): ReactNode {
  const codeMode = usePresetIds(ids => ids.has(sessionId))
  const [report, setReport] = useState<SelfTestReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [building, setBuilding] = useState(false)
  const [preparing, setPreparing] = useState(false)
  useEffect(() => {
    if (!codeMode) return
    let live = true
    void setup(false).then((result) => {
      if (!live) return
      if (result.ok) setReport(result.value)
      else setError(result.message)
    })
    return () => { live = false }
  }, [codeMode, setup])
  if (!codeMode || report === null || report.ok) return null
  return (
    <div style={{ ...note, maxWidth: 520 }} role="alert">
      <strong>{t('setup.title')}</strong>
      <ul style={{ margin: '4px 0', paddingLeft: 18 }}>
        {report.checks.filter(c => !c.ok).map(c => (
          <li key={c.id}>{c.detail}{c.remedy !== undefined && <div style={{ opacity: 0.85 }}>{c.remedy}</div>}</li>
        ))}
      </ul>
      {building && <div>{t('setup.building')}</div>}
      {preparing && <div>{t('setup.preparing')}</div>}
      {error !== null && <div role="alert">{t('error.generic', { error })}</div>}
      <div style={row}>
        <Button size="sm" variant="outline" disabled={building || preparing} onClick={() => { void setup(true).then(r => { if (r.ok) setReport(r.value) }) }}>{t('setup.retry')}</Button>
        {report.checks.some(c => !c.ok && c.action === 'prepare-remote') && (
          <Button
            size="sm"
            disabled={preparing}
            onClick={() => {
              setPreparing(true)
              setError(null)
              void prepareRemote().then((r) => {
                setPreparing(false)
                if (r.ok) setReport(r.value)
                else setError(r.message)
              })
            }}
          >
            {t('setup.prepareRemote')}
          </Button>
        )}
        {report.checks.some(c => !c.ok && c.action === 'build-worker') && (
          <Button
            size="sm"
            disabled={building}
            onClick={() => {
              setBuilding(true)
              setError(null)
              void buildWorker().then((r) => {
                setBuilding(false)
                if (r.ok) setReport(r.value)
                else setError(r.message)
              })
            }}
          >
            {t('setup.build')}
          </Button>
        )}
      </div>
    </div>
  )
}

// ── Provisioning status (conversation.input.dock) ──────────────────────────

/** Injected face of the composer status line. */
export interface StatusInjected {
  readonly hooks: { readonly view: HostObservable<CodeSessionView | null>; readonly presetIds: HostObservable<ReadonlySet<string>> }
  readonly sessionId: string
}

/**
 * One-line workspace status above the composer for Code sessions.
 * @param props - injected session view and translator.
 * @returns the status line, or nothing for other sessions.
 */
export function WorkspaceStatusLine({ useView, usePresetIds, sessionId, t }: InjectFace<StatusInjected> & PropsLocale<typeof NS>): ReactNode {
  const view = useView(value => value)
  const codeMode = usePresetIds(ids => ids.has(sessionId))
  if (view === null) return null
  // The choice itself is shown beside the + button (SelectionLabel).
  if (view.status === 'pending') return null
  const text = statusText(view, t)
  if (text === undefined) return null
  // The dock floats over the conversation, so the line has the page's own background.
  return <div style={{ ...note, padding: '4px 10px', borderRadius: 8, background: 'var(--dsw-alias-bg-base)', justifySelf: 'start' }} role="status" aria-live="polite">{text}</div>
}

function statusText(view: CodeSessionView, t: T): string | undefined {
  switch (view.status) {
    case 'pending': return undefined
    case 'created':
    case 'provisioning': return t('status.provisioning')
    case 'restarting': return t('status.restarting')
    // A ready workspace needs no line; the header actions show it is a Code session.
    case 'ready': return undefined
    case 'offline': return t('status.offline')
    case 'failed': return t('status.failed', { error: view.error ?? '' })
    case 'deleting':
    case 'deleted': return undefined
    default: return undefined
  }
}

// ── Session actions (conversation.session.header.actions) ──────────────────

/** Injected face of the header actions. */
export interface ActionsInjected {
  readonly hooks: { readonly view: HostObservable<CodeSessionView | null> }
  readonly pendingWork: () => Promise<Outcome<PendingWork | null>>
  readonly remove: () => Promise<Outcome<void>>

}

type Dialog =
  | { kind: 'delete'; pending: PendingWork | null } | { kind: 'message'; text: string }


/**
 * Format a byte count.
 * @param bytes - byte count.
 * @returns a short human-readable size.
 */
export function formatBytes(bytes: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++ }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`
}

/** Live resource figures, polled while the dialog is open. */
function ResourcesBody({ usage, t }: { readonly usage: () => Promise<Outcome<WorkspaceUsage | null>>; readonly t: T }): ReactNode {
  const [value, setValue] = useState<WorkspaceUsage | null | undefined>(undefined)
  useEffect(() => {
    let live = true
    const tick = (): void => { void usage().then((r) => { if (live) setValue(r.ok ? r.value : null) }) }
    tick()
    const timer = setInterval(tick, 2000)
    return () => { live = false; clearInterval(timer) }
  }, [usage])
  if (value === undefined) return <div style={note}>{t('picker.loading')}</div>
  if (value === null) return <div style={note}>{t('resources.unavailable')}</div>
  const rows: Array<[string, string]> = [
    [t('resources.cpu'), `${value.cpuPercent.toFixed(1)}%`],
    [t('resources.memory'), `${formatBytes(value.memoryBytes)} / ${formatBytes(value.memoryLimitBytes)}`],
    [t('resources.pids'), `${value.pids} / ${value.pidsLimit}`],
    [t('resources.disk'), formatBytes(value.diskBytes)],
  ]
  return (
    <dl style={{ ...grid, gridTemplateColumns: 'auto 1fr' }}>
      {rows.map(([label, text]) => [<dt key={`${label}-k`} style={term}>{label}</dt>, <dd key={`${label}-v`} style={{ margin: 0 }}>{text}</dd>])}
    </dl>
  )
}

/**
 * The Delete session action for a Code session.
 * @param props - injected Remote calls, session view and translator.
 * @returns the action buttons and their dialogs, or nothing for other sessions.
 */
export function SessionActions({ useView, pendingWork, remove, t }: InjectFace<ActionsInjected> & PropsLocale<typeof NS>): ReactNode {
  const view = useView(value => value)
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [busy, setBusy] = useState(false)
  const close = useMemo(() => () => { setDialog(null) }, [])
  if (view === null || view.status === 'pending' || view.status === 'deleted') return null
  const run = async <V,>(work: () => Promise<Outcome<V>>, done: (value: V) => Dialog | null): Promise<void> => {
    setBusy(true)
    const result = await work()
    setBusy(false)
    setDialog(result.ok ? done(result.value) : { kind: 'message', text: t('error.generic', { error: result.message }) })
  }
  const ready = view.status === 'ready'
  return (
    <div style={row}>
      <Button size="sm" disabled={busy} onClick={() => { void run(pendingWork, pending => ({ kind: 'delete', pending })) }}>{t('action.delete')}</Button>
      <Modal
        open={dialog?.kind === 'delete'}
        onClose={close}
        closeLabel={t('action.close')}
        title={t('delete.title')}
        description={dialog?.kind === 'delete' && dialog.pending !== null && (dialog.pending.dirtyFiles > 0 || dialog.pending.unpushedCommits > 0)
          ? t('delete.warning', { files: String(dialog.pending.dirtyFiles), commits: String(dialog.pending.unpushedCommits) })
          : t('delete.clean')}
        footer={<Button variant="primary" disabled={busy} onClick={() => { void run(remove, () => null) }}>{t('delete.confirm')}</Button>}
      />
      <Modal open={dialog?.kind === 'message'} onClose={close} closeLabel={t('action.close')} title={t('dialog.title')} description={dialog?.kind === 'message' ? dialog.text : ''} />
    </div>
  )
}

// ── Environment (header dialog) ─────────────────────────────────────────────

const grid: CSSProperties = { display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '6px 16px', fontSize: 13, lineHeight: '20px', margin: 0 }
const term: CSSProperties = { color: 'var(--dsw-alias-label-secondary)' }
/** Identifiers (repository, branches, commits, hosts) in the monospace font at the body size; other values stay in the body font. */
const value: CSSProperties = { margin: 0, fontFamily: 'var(--dsw-font-mono, ui-monospace, monospace)', fontSize: 12, overflowWrap: 'anywhere' }
const plain: CSSProperties = { margin: 0, overflowWrap: 'anywhere' }
/** Headings inside the Environment tab, the same as the Settings > Code group headings. */
const tabHeading: CSSProperties = { margin: 0, fontSize: 14, lineHeight: '22px', fontWeight: 500 }

/**
 * Where this Code session runs: account, repository, branches, container, network and limits, then the
 * provisioning timeline. Reloads every second while the workspace is still starting.
 * @param props - environment loader, current workspace status and translator.
 * @returns the details.
 */
function EnvironmentPanel({ load, status, side, t }: { readonly load: () => Promise<Outcome<SessionEnvironment>>; readonly status: string; readonly side?: ReactNode; readonly t: T }): ReactNode {
  const [env, setEnv] = useState<SessionEnvironment | null>(null)
  const [error, setError] = useState<string | null>(null)
  const settling = env === null || (env.steps !== undefined && env.steps.length > 0 && !['ready', 'failed'].includes(env.steps[env.steps.length - 1]!.step))
  useEffect(() => {
    let live = true
    const tick = (): void => {
      void load().then((result) => {
        if (!live) return
        if (result.ok) { setEnv(result.value); setError(null) } else setError(result.message)
      })
    }
    tick()
    if (!settling) return () => { live = false }
    const timer = setInterval(tick, 1000)
    return () => { live = false; clearInterval(timer) }
  }, [load, status, settling])
  if (error !== null) return <div style={note} role="alert">{t('error.generic', { error })}</div>
  if (env === null) return <div style={note}>{t('picker.loading')}</div>
  const options = env.options
  const sandbox = options === undefined ? undefined : [
    `${t('env.lockdown')}: ${options.lockdown ? t('env.on') : t('env.off')}`,
    `${t('env.readOnlyWorkspace')}: ${options.readOnlyWorkspace ? t('env.on') : t('env.off')}`,
    `${t('env.dependencyCache')}: ${options.dependencyCache ? t('env.on') : t('env.off')}`,
    `${t('env.dockerHost')}: ${options.remote === true ? t('env.dockerHost.remote') : t('env.dockerHost.local')}`,
    ...options.storage === undefined ? [] : [`${t('env.storage')}: ${options.storage === 'volume' ? t('env.storage.volume') : t('env.storage.bind')}`],
    ...options.readOnlyFolders.length === 0 ? [] : [t('env.foldersCount', { count: String(options.readOnlyFolders.length) })],
  ].join(' · ')
  // The third field marks identifiers, shown in the monospace font.
  const rows: [string, string | undefined, boolean?][] = env.mode === 'host'
    ? [[t('env.runs'), t('env.host')], [t('env.directory'), env.workingDirectory, true]]
    : [
      [t('env.runs'), t('env.code')],
      [t('env.account'), env.account, true],
      [t('env.repository'), env.repository, true],
      [t('env.baseBranch'), env.baseBranch, true],
      [t('env.baseCommit'), env.baseCommit?.slice(0, 12), true],
      [t('env.workingBranch'), env.workingBranch, true],
      [t('env.status'), env.status],
      [t('env.permission'), env.permission === undefined ? undefined : env.permission === 'read-only' ? t('env.permissionReadOnly') : env.permission === 'danger-full-access' ? t('env.permissionFullAccess') : t('env.permissionWrite')],
      [t('env.network'), env.network === undefined ? undefined : t('env.networkValue', { mode: env.network })],
      [t('env.sandbox'), sandbox],
    ]
  return (
    <div style={{ display: 'grid', gap: 20 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 24, alignItems: 'start' }}>
      <dl style={grid}>
        {rows.filter((row): row is [string, string, boolean?] => row[1] !== undefined && row[1] !== '').map(([k, v, mono]) => (
          <div key={k} style={{ display: 'contents' }}>
            <dt style={term}>{k}</dt>
            <dd style={mono === true ? value : plain}>{v}</dd>
          </div>
        ))}
      </dl>
      {side}
      </div>
      {env.steps !== undefined && env.steps.length > 0 && <ProvisionSteps steps={env.steps} t={t} />}
    </div>
  )
}

const STEP_COLORS: Record<string, string> = {
  held: '#8e8e93', 'checking-runtime': '#5b8def', 'egress-proxy': '#9b7be0', 'resolving-revision': '#e0a23c',
  cloning: '#4caf7d', 'starting-container': '#e07a3c', 'health-check': '#3cb3c4', 'working-directory': '#b0b0b8',
  ready: '#4caf7d', failed: '#d9534f',
}

/**
 * The latest provisioning as a timeline: an overview bar with one span per step, then one row per step with
 * its label, duration and its span on the same time scale. Steps run one after another, so spans do not overlap.
 * @param props - recorded steps and translator.
 * @returns the timeline.
 */
function ProvisionSteps({ steps, t }: { readonly steps: readonly ProvisionStep[]; readonly t: T }): ReactNode {
  const start = steps[0]!.time
  const lastStep = steps[steps.length - 1]!
  const done = lastStep.step === 'ready' || lastStep.step === 'failed'
  const end = Math.max(done ? lastStep.time : Date.now(), start + 1)
  const total = end - start
  const spans = steps.map((s, i) => {
    const next = steps[i + 1]
    const until = next?.time ?? (done ? s.time : end)
    return { ...s, offset: s.time - start, duration: Math.max(until - s.time, 0), open: next === undefined && !done }
  })
  const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`
  const label = (step: string): string => {
    const key = `step.${step}` as never
    const text = t(key)
    return text === `step.${step}` ? step : text
  }
  const pct = (ms: number): string => `${(ms / total) * 100}%`
  const bar = (s: typeof spans[number], height: number): ReactNode => (
    <div
      key={`${s.step}-${s.time}`}
      title={`${label(s.step)} · ${seconds(s.duration)}`}
      style={{ position: 'absolute', left: pct(s.offset), width: `max(${pct(s.duration)}, 2px)`, top: 0, height, borderRadius: 2, background: STEP_COLORS[s.step] ?? '#8e8e93', opacity: s.open ? 0.6 : 1 }}
    />
  )
  return (
    <section>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
        <h3 style={tabHeading}>{t('env.steps', { when: new Date(start).toLocaleString() })}</h3>
        <span style={{ ...term, fontSize: 12 }}>{done ? t('step.total', { total: seconds(total) }) : t('step.running')}</span>
      </div>
      <div style={{ position: 'relative', height: 10, marginBottom: 10, background: 'var(--dsw-alias-bg-subtle, rgba(127,127,127,.12))', borderRadius: 2 }}>
        {spans.map(s => bar(s, 10))}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(180px, 2fr) 56px 3fr', gap: '6px 12px', alignItems: 'center', fontSize: 12 }}>
        {spans.map(s => (
          <div key={`${s.step}-${s.time}`} style={{ display: 'contents' }}>
            <span style={s.step === 'failed' ? { color: '#d9534f' } : undefined}>
              <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, marginRight: 6, background: STEP_COLORS[s.step] ?? '#8e8e93' }} />
              {label(s.step)}
              {s.error !== undefined && <div style={{ ...value, fontSize: 11, marginLeft: 14 }}>{s.error}</div>}
            </span>
            <span style={{ ...term, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{s.open ? '…' : seconds(s.duration)}</span>
            <div style={{ position: 'relative', height: 8 }}>{bar(s, 8)}</div>
          </div>
        ))}
      </div>
    </section>
  )
}

// ── Settings > Code (settings.section) ──────────────────────────────────────

/** Injected face of the settings page. */
export interface SettingsInjected {
  readonly load: () => Promise<Outcome<CodeSettingsView>>
  readonly accounts: () => Promise<Outcome<GhAccount[]>>
  /** The Harness folder picker (in-app browser on the web, native dialog on desktop); null when cancelled or unavailable. */
  readonly pickFolder?: () => Promise<string | null>
  readonly save: (settings: CodeSettings) => Promise<Outcome<CodeSettingsView>>
  readonly remoteAddress: () => Promise<Outcome<FirewallView>>
  readonly detectAddress: () => Promise<Outcome<FirewallView>>
  readonly tailscaleJoin: () => Promise<Outcome<TailscaleJoinView>>
  readonly tailscaleStatus: () => Promise<Outcome<TailscaleJoinView>>
}

/** Commands in a selectable block with a Copy button. */
function CommandBlock({ title, lines, t }: { readonly title: string; readonly lines: readonly string[]; readonly t: T }): ReactNode {
  const [copied, setCopied] = useState(false)
  return (
    <div style={{ display: 'grid', gap: 4 }}>
      <div style={{ ...row, justifyContent: 'space-between' }}>
        <span style={note}>{title}</span>
        <Button size="sm" variant="outline" onClick={() => { void navigator.clipboard.writeText(lines.join('\n')).then(() => { setCopied(true) }, () => { setCopied(false) }) }}>{copied ? t('remote.copied') : t('remote.copy')}</Button>
      </div>
      <pre style={{ ...value, margin: 0, fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{lines.join('\n')}</pre>
    </div>
  )
}

/**
 * Restrict SSH to this dsh: the address the VM sees (or one from a public echo service, only on click) and the
 * firewall commands for it. Optional and collapsed; it uses the saved settings, and shows the address only here.
 */
function RestrictSsh({ remoteAddress, detectAddress, saved, t }: { readonly remoteAddress: () => Promise<Outcome<FirewallView>>; readonly detectAddress: () => Promise<Outcome<FirewallView>>; readonly saved: boolean; readonly t: T }): ReactNode {
  const [view, setView] = useState<FirewallView | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const run = (action: () => Promise<Outcome<FirewallView>>): void => {
    setBusy(true)
    setMessage(null)
    void action().then((r) => {
      setBusy(false)
      if (r.ok) setView(r.value)
      else setMessage(t('error.generic', { error: r.message }))
    })
  }
  return (
    <details style={{ padding: '12px 0', borderBottom: '0.5px solid var(--dsw-alias-border-l2, rgba(127,127,127,.25))' }}>
      <summary style={{ cursor: 'pointer', fontSize: 14, lineHeight: '20px' }}>{t('remote.restrict')}</summary>
      <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
        <div style={note}>{t('remote.restrictHint')}</div>
        <div style={row}>
          <Button size="sm" disabled={busy || !saved} onClick={() => { run(remoteAddress) }}>{t('remote.askVm')}</Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => { run(detectAddress) }}>{t('remote.detect')}</Button>
        </div>
        {!saved && <div style={note}>{t('remote.saveFirst')}</div>}
        {message !== null && <div style={note} role="alert">{message}</div>}
        {view !== null && (
          <>
            <div>{t('remote.address')}: <code style={value}>{view.address}</code></div>
            <CommandBlock title={t('remote.azureAllow')} lines={view.allowOnly.azure} t={t} />
            <CommandBlock title={t('remote.awsAllow')} lines={view.allowOnly.aws} t={t} />
          </>
        )}
      </div>
    </details>
  )
}

/**
 * Join the VM to Tailscale over the current SSH connection, then switch the host to its tailnet address. Optional;
 * the user approves the VM in their own browser through the link Tailscale prints.
 */
function TailscaleJoinPanel({ join, status, onUse, saved, t }: { readonly join: () => Promise<Outcome<TailscaleJoinView>>; readonly status: () => Promise<Outcome<TailscaleJoinView>>; readonly onUse: (address: string) => void; readonly saved: boolean; readonly t: T }): ReactNode {
  const [view, setView] = useState<TailscaleJoinView>({ state: 'idle' })
  const [message, setMessage] = useState<string | null>(null)
  const active = view.state === 'installing' || view.state === 'waiting-for-login'
  useEffect(() => {
    let live = true
    void status().then((r) => { if (live && r.ok) setView(r.value) })
    return () => { live = false }
  }, [status])
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => { void status().then((r) => { if (r.ok) setView(r.value) }) }, 2000)
    return () => { clearInterval(timer) }
  }, [active, status])
  return (
    <details style={{ padding: '12px 0', borderBottom: '0.5px solid var(--dsw-alias-border-l2, rgba(127,127,127,.25))' }}>
      <summary style={{ cursor: 'pointer', fontSize: 14, lineHeight: '20px' }}>{t('remote.tailscale')}</summary>
      <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
        <div style={note}>{t('remote.tailscaleHint')}</div>
        <div style={row}>
          <Button size="sm" disabled={!saved || active} onClick={() => {
            setMessage(null)
            void join().then((r) => { if (r.ok) setView(r.value); else setMessage(t('error.generic', { error: r.message })) })
          }}>{t('remote.tailscaleJoin')}</Button>
        </div>
        {!saved && <div style={note}>{t('remote.saveFirst')}</div>}
        {view.state === 'installing' && <div style={note} role="status">{t('remote.tailscaleInstalling')}</div>}
        {view.state === 'waiting-for-login' && view.loginUrl !== undefined && (
          <div role="status">{t('remote.tailscaleLogin')} <a href={view.loginUrl} target="_blank" rel="noopener noreferrer">{view.loginUrl}</a></div>
        )}
        {view.state === 'joined' && view.address !== undefined && (
          <div style={{ display: 'grid', gap: 6 }}>
            <div>{t('remote.tailscaleJoined')}: <code style={value}>{view.address}</code></div>
            <div style={row}><Button size="sm" variant="primary" onClick={() => { onUse(view.address!) }}>{t('remote.tailscaleUse')}</Button></div>
            <div style={note}>{t('remote.tailscaleUseHint')}</div>
          </div>
        )}
        {view.state === 'failed' && <div style={note} role="alert">{t('error.generic', { error: view.error ?? '' })}</div>}
        {message !== null && <div style={note} role="alert">{message}</div>}
      </div>
    </details>
  )
}

type Draft = Record<'allow' | 'privateAllow' | 'ports' | 'previewPorts' | 'cpus' | 'memoryMb' | 'pids' | 'tmpMb' | 'maxWorkspaces' | 'workerImage' | 'shmMb' | 'readOnlyFolders' | 'environment' | 'remoteHost' | 'remotePort' | 'remoteUser' | 'remoteIdentityFile' | 'remoteHostKey' | 'remotePublicHost' | 'remoteAwsInstanceId' | 'remoteAwsRegion' | 'remoteAwsProfile' | 'remoteAzureBastion' | 'remoteAzureResourceGroup' | 'remoteAzureVmId' | 'remoteAzureSubscription', string>
  & { network: CodeSettings['network']; disabledAccounts: readonly string[]; newBranch: boolean; readOnlyWorkspace: boolean; dependencyCache: boolean; lockdown: boolean; previewEnabled: boolean; isolatedBrowser: boolean; storage: CodeSettings['storage']; remoteNetwork: CodeSettings['remoteNetwork']; remoteVia: CodeSettings['remoteVia'] }

function toDraft(settings: CodeSettings): Draft {
  return {
    network: settings.network,
    allow: settings.allow.join('\n'), privateAllow: settings.privateAllow.join('\n'),
    ports: settings.ports.join(', '), previewPorts: settings.previewPorts.join(', '),
    cpus: String(settings.cpus), memoryMb: String(settings.memoryMb), pids: String(settings.pids), tmpMb: String(settings.tmpMb),
    maxWorkspaces: String(settings.maxWorkspaces), workerImage: settings.workerImage,
    disabledAccounts: settings.disabledAccounts, newBranch: settings.newBranch,
    shmMb: String(settings.shmMb), readOnlyFolders: settings.readOnlyFolders.join('\n'), environment: settings.environment.join('\n'),
    readOnlyWorkspace: settings.readOnlyWorkspace, dependencyCache: settings.dependencyCache, lockdown: settings.lockdown,
    previewEnabled: settings.previewEnabled, isolatedBrowser: settings.isolatedBrowser, storage: settings.storage,
    remoteHost: settings.remoteHost, remotePort: String(settings.remotePort), remoteUser: settings.remoteUser, remoteIdentityFile: settings.remoteIdentityFile, remoteHostKey: settings.remoteHostKey,
    remoteNetwork: settings.remoteNetwork, remotePublicHost: settings.remotePublicHost, remoteVia: settings.remoteVia,
    remoteAwsInstanceId: settings.remoteAwsInstanceId, remoteAwsRegion: settings.remoteAwsRegion, remoteAwsProfile: settings.remoteAwsProfile, remoteAzureBastion: settings.remoteAzureBastion, remoteAzureResourceGroup: settings.remoteAzureResourceGroup, remoteAzureVmId: settings.remoteAzureVmId, remoteAzureSubscription: settings.remoteAzureSubscription,
  }
}

/**
 * Parse the form back into settings; the host validates again.
 * @param draft - form state.
 * @returns settings.
 */
export function fromDraft(draft: Draft): CodeSettings {
  const lines = (text: string): string[] => text.split(/[\n,]/).map(x => x.trim()).filter(x => x !== '')
  const numbers = (text: string): number[] => lines(text).map(Number)
  return {
    network: draft.network, allow: lines(draft.allow), privateAllow: lines(draft.privateAllow),
    ports: numbers(draft.ports), previewPorts: numbers(draft.previewPorts),
    cpus: Number(draft.cpus), memoryMb: Number(draft.memoryMb), pids: Number(draft.pids), tmpMb: Number(draft.tmpMb),
    maxWorkspaces: Number(draft.maxWorkspaces), workerImage: draft.workerImage.trim(),
    disabledAccounts: draft.disabledAccounts, newBranch: draft.newBranch,
    shmMb: Number(draft.shmMb), readOnlyFolders: draft.readOnlyFolders.split('\n').map(x => x.trim()).filter(x => x !== ''),
    environment: draft.environment.split('\n').map(x => x.trim()).filter(x => x !== ''),
    readOnlyWorkspace: draft.readOnlyWorkspace, dependencyCache: draft.dependencyCache, lockdown: draft.lockdown,
    previewEnabled: draft.previewEnabled, isolatedBrowser: draft.isolatedBrowser, storage: draft.storage,
    remoteHost: draft.remoteHost.trim(), remotePort: Number(draft.remotePort), remoteUser: draft.remoteUser.trim(), remoteIdentityFile: draft.remoteIdentityFile.trim(), remoteHostKey: draft.remoteHostKey.trim(),
    remoteNetwork: draft.remoteNetwork, remotePublicHost: draft.remotePublicHost.trim(), remoteVia: draft.remoteVia,
    remoteAwsInstanceId: draft.remoteAwsInstanceId.trim(), remoteAwsRegion: draft.remoteAwsRegion.trim(), remoteAwsProfile: draft.remoteAwsProfile.trim(), remoteAzureBastion: draft.remoteAzureBastion.trim(), remoteAzureResourceGroup: draft.remoteAzureResourceGroup.trim(), remoteAzureVmId: draft.remoteAzureVmId.trim(), remoteAzureSubscription: draft.remoteAzureSubscription.trim(),
  }
}

/** Type and spacing of Settings > Code, matching the Harness's own settings pages. */
const text = {
  title: { margin: 0, fontSize: 16, lineHeight: '24px', fontWeight: 500 },
  intro: { margin: 0, fontSize: 14, lineHeight: '22px', color: 'var(--dsw-alias-label-tertiary)' },
  heading: { margin: 0, fontSize: 14, lineHeight: '22px', fontWeight: 500 },
  label: { fontSize: 14, lineHeight: '20px' },
  hint: { margin: 0, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)' },
} satisfies Record<string, CSSProperties>
const divider = '0.5px solid var(--dsw-alias-border-l2, rgba(127,127,127,.25))'
const warnColor = 'var(--dsw-alias-state-warn-label, #b26b00)'
const monoFont = 'var(--dsw-font-mono, ui-monospace, monospace)'
const textArea: CSSProperties = { ...select, maxWidth: 'none', width: '100%', boxSizing: 'border-box', fontFamily: monoFont, fontSize: 12, lineHeight: '18px', padding: '6px 8px', resize: 'vertical' }

type TextKey = Exclude<keyof Draft, 'network' | 'allow' | 'privateAllow' | 'disabledAccounts' | 'newBranch' | 'readOnlyWorkspace' | 'dependencyCache' | 'lockdown' | 'previewEnabled' | 'isolatedBrowser' | 'storage' | 'remoteNetwork' | 'remoteVia' | 'readOnlyFolders' | 'environment'>

/** One group of settings: a heading, an optional line under it, and its rows. */
function SettingsGroup({ title, hint, children }: { readonly title: string; readonly hint?: string; readonly children: ReactNode }): ReactNode {
  return (
    <section aria-label={title} style={{ display: 'grid' }}>
      <h3 style={text.heading}>{title}</h3>
      {hint !== undefined && <p style={{ ...text.hint, marginTop: 4 }}>{hint}</p>}
      <div style={{ display: 'grid', marginTop: 4, borderTop: divider }}>{children}</div>
    </section>
  )
}

/** A setting with its control on the right: switches. */
function SettingRow({ label, hint, children }: { readonly label: string; readonly hint?: string; readonly children: ReactNode }): ReactNode {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 24, padding: '12px 0', borderBottom: divider }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={text.label}>{label}</div>
        {hint !== undefined && <p style={{ ...text.hint, marginTop: 4 }}>{hint}</p>}
      </div>
      <div style={{ flex: 'none' }}>{children}</div>
    </div>
  )
}

/** A setting with its control below the label: text, lists and choices. */
function SettingBlock({ label, hint, children }: { readonly label: string; readonly hint?: string; readonly children: ReactNode }): ReactNode {
  return (
    <div style={{ display: 'grid', gap: 8, padding: '12px 0', borderBottom: divider, minWidth: 0 }}>
      <div style={text.label}>{label}</div>
      {children}
      {hint !== undefined && <p style={text.hint}>{hint}</p>}
    </div>
  )
}

/**
 * Settings > Code: network policy, resource limits, worker image and preview ports.
 * @param props - injected load/save and translator.
 * @returns the settings page.
 */
export function CodeSettingsSection({ load, save, accounts, pickFolder, remoteAddress, detectAddress, tailscaleJoin, tailscaleStatus, t }: SettingsInjected & PropsLocale<typeof NS>): ReactNode {
  const [saved, setSaved] = useState<CodeSettings | null>(null)
  const [closePublic, setClosePublic] = useState<CodeSettingsView['closePublic'] | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [logins, setLogins] = useState<GhAccount[] | null>(null)
  const [accountsError, setAccountsError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    void accounts().then((r) => {
      if (!live) return
      if (r.ok) setLogins(r.value)
      else setAccountsError(r.message)
    })
    return () => { live = false }
  }, [accounts])
  const [writable, setWritable] = useState(true)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let live = true
    void load().then((r) => {
      if (!live) return
      if (r.ok) { setDraft(toDraft(r.value.settings)); setSaved(r.value.settings); setClosePublic(r.value.closePublic ?? null); setWritable(r.value.writable) }
      else setMessage(t('error.generic', { error: r.message }))
    })
    return () => { live = false }
  }, [load, t])
  if (draft === null) return <div style={note}>{message ?? t('picker.loading')}</div>
  // The VM actions use the running Code, so they wait until the remote fields on screen are saved.
  const remoteOn = draft.remoteVia === 'aws-ssm' ? draft.remoteAwsInstanceId.trim() !== '' : draft.remoteVia === 'azure-bastion' ? draft.remoteAzureVmId.trim() !== '' : draft.remoteHost.trim() !== ''
  const current = fromDraft(draft)
  const savedRemote = saved !== null && remoteOn && (['remoteHost', 'remotePort', 'remoteUser', 'remoteIdentityFile', 'remoteHostKey', 'remoteVia', 'remoteAwsInstanceId', 'remoteAwsRegion', 'remoteAwsProfile', 'remoteAzureBastion', 'remoteAzureResourceGroup', 'remoteAzureVmId', 'remoteAzureSubscription'] as const).every(key => saved[key] === current[key])
  const textKeys = (key: TextKey): ReactNode => (
    <Input aria-label={t(`settings.${key}`)} type={key === 'remotePort' ? 'number' : 'text'} value={draft[key]} onChange={(event) => { setDraft({ ...draft, [key]: event.target.value }) }} />
  )
  const field = (key: TextKey, hint?: string): ReactNode => (
    <SettingBlock label={t(`settings.${key}`)} hint={hint}>{textKeys(key)}</SettingBlock>
  )
  const numberCell = (key: TextKey): ReactNode => (
    <label key={key} style={{ display: 'grid', gap: 4, minWidth: 0 }}>
      <span style={text.hint}>{t(`settings.${key}`)}</span>
      <Input aria-label={t(`settings.${key}`)} type="number" value={draft[key]} onChange={(event) => { setDraft({ ...draft, [key]: event.target.value }) }} />
    </label>
  )
  const switchRow = (key: 'readOnlyWorkspace' | 'dependencyCache' | 'lockdown' | 'previewEnabled' | 'isolatedBrowser' | 'newBranch', label: string, hint: string): ReactNode => (
    <SettingRow label={label} hint={hint}>
      <Switch label={label} checked={draft[key]} onChange={(on) => { setDraft({ ...draft, [key]: on }) }} />
    </SettingRow>
  )
  const area = (key: 'allow' | 'privateAllow' | 'readOnlyFolders' | 'environment', hint?: string, extra?: ReactNode): ReactNode => (
    <SettingBlock label={t(`settings.${key}`)} hint={hint}>
      <textarea aria-label={t(`settings.${key}`)} rows={key === 'allow' ? 6 : 3} value={draft[key]} style={textArea} onChange={(event) => { setDraft({ ...draft, [key]: event.target.value }) }} />
      {extra}
    </SettingBlock>
  )
  const remoteLogin = (
    <>
      {field('remotePort')}
      {field('remoteUser')}
      {field('remoteIdentityFile')}
      {field('remoteHostKey', t('settings.remoteSaveHint'))}
    </>
  )
  return (
    <form
      style={{ display: 'grid', gap: 28, maxWidth: 720 }}
      onSubmit={(event) => {
        event.preventDefault()
        setBusy(true)
        setMessage(null)
        void save(fromDraft(draft)).then((r) => {
          setBusy(false)
          if (r.ok) { setDraft(toDraft(r.value.settings)); setSaved(r.value.settings); setWritable(r.value.writable); setMessage(t(r.value.reloaded === true ? 'settings.savedReloaded' : 'settings.saved')) }
          else setMessage(t('error.generic', { error: r.message }))
        })
      }}
    >
      <header style={{ display: 'grid', gap: 4 }}>
        <h2 style={text.title}>{t('settings.title')}</h2>
        <p style={text.intro}>{t('settings.intro')}</p>
        {!writable && <p style={{ ...text.hint, color: warnColor }} role="note">{t('settings.notWritable')}</p>}
      </header>

      <SettingsGroup title={t('settings.group.protection')}>
        {switchRow('lockdown', t('settings.lockdown'), t('settings.lockdownHint'))}
        {draft.lockdown && <p style={{ ...text.hint, color: warnColor, padding: '12px 0', borderBottom: divider }} role="note">{t('settings.lockdownActive')}</p>}
      </SettingsGroup>

      <SettingsGroup title={t('settings.group.github')}>
        <SettingBlock label={t('settings.accounts')} hint={t('settings.accountsHint')}>
          {accountsError !== null && <p style={{ ...text.hint, color: warnColor }} role="alert">{t('error.generic', { error: accountsError })}</p>}
          {logins === null && accountsError === null && <p style={text.hint}>{t('picker.loading')}</p>}
          {logins?.length === 0 && <p style={text.hint}>{t('settings.noAccounts')}</p>}
          {logins !== null && logins.length > 0 && (
            <div style={{ display: 'grid', gap: 6 }}>
              {logins.map(({ login }) => (
                <div key={login} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 24 }}>
                  <span style={text.label}>{login}</span>
                  <Switch
                    label={t('settings.accountToggle', { login })}
                    checked={!draft.disabledAccounts.includes(login)}
                    onChange={(on) => {
                      const rest = draft.disabledAccounts.filter(l => l !== login)
                      setDraft({ ...draft, disabledAccounts: on ? rest : [...rest, login] })
                    }}
                  />
                </div>
              ))}
            </div>
          )}
        </SettingBlock>
        {switchRow('newBranch', t('settings.newBranch'), draft.newBranch ? t('settings.newBranchOn') : t('settings.newBranchOff'))}
      </SettingsGroup>

      <SettingsGroup title={t('settings.network')}>
        <SettingBlock label={t('settings.networkMode')} hint={draft.network === 'open' ? undefined : t('settings.networkModeHint')}>
          <SegmentedControl<CodeSettings['network']>
            id="dsh-code-network"
            label={t('settings.networkMode')}
            value={draft.network}
            onChange={(network) => { setDraft({ ...draft, network }) }}
            options={[
              { value: 'allowlist', label: t('settings.network.allowlist') },
              { value: 'none', label: t('settings.network.none') },
              { value: 'open', label: t('settings.network.open') },
            ]}
          />
          {draft.network === 'open' && <p style={{ ...text.hint, color: warnColor }} role="alert">{t('settings.network.openWarning')}</p>}
        </SettingBlock>
        {area('allow')}
        {area('privateAllow')}
        {field('ports')}
      </SettingsGroup>

      <SettingsGroup title={t('settings.workspace')}>
        <SettingBlock label={t('settings.storage')} hint={t('settings.storageHint')}>
          <SegmentedControl<CodeSettings['storage']>
            id="dsh-code-storage"
            label={t('settings.storage')}
            value={draft.storage}
            onChange={(storage) => { setDraft({ ...draft, storage }) }}
            options={[
              { value: 'auto', label: t('settings.storage.auto') },
              { value: 'bind', label: t('settings.storage.bind') },
              { value: 'volume', label: t('settings.storage.volume') },
            ]}
          />
        </SettingBlock>
        <fieldset disabled={draft.lockdown} style={{ border: 0, padding: 0, margin: 0, minWidth: 0, opacity: draft.lockdown ? 0.55 : 1 }}>
          {switchRow('readOnlyWorkspace', t('settings.readOnlyWorkspace'), t('settings.readOnlyWorkspaceHint'))}
          {switchRow('dependencyCache', t('settings.dependencyCache'), t('settings.dependencyCacheHint'))}
          {area('readOnlyFolders', t('settings.readOnlyFoldersHint'), pickFolder === undefined ? undefined : (
            <div>
              <Button
                size="sm"
                variant="outline"
                type="button"
                onClick={() => {
                  void pickFolder().then((folder) => {
                    if (folder === null || folder === '') return
                    const listed = draft.readOnlyFolders.split('\n').map(x => x.trim()).filter(x => x !== '')
                    if (!listed.includes(folder)) setDraft({ ...draft, readOnlyFolders: [...listed, folder].join('\n') })
                  })
                }}
              >
                {t('settings.addFolder')}
              </Button>
            </div>
          ))}
        </fieldset>
        {area('environment', t('settings.environmentHint'))}
      </SettingsGroup>

      <SettingsGroup title={t('settings.preview')}>
        {switchRow('previewEnabled', t('settings.previewEnabled'), t('settings.previewEnabledHint'))}
        {draft.previewEnabled && switchRow('isolatedBrowser', t('settings.isolatedBrowser'), t('settings.isolatedBrowserHint'))}
        {field('previewPorts')}
      </SettingsGroup>

      <SettingsGroup title={t('settings.limits')} hint={t('settings.limitsHint')}>
        <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', padding: '12px 0', borderBottom: divider }}>
          {(['cpus', 'memoryMb', 'pids', 'tmpMb', 'shmMb', 'maxWorkspaces'] as const).map(numberCell)}
        </div>
      </SettingsGroup>

      <SettingsGroup title={t('settings.group.where')} hint={t('settings.remoteHint')}>
        <SettingBlock label={t('settings.remoteVia')}>
          <SegmentedControl<CodeSettings['remoteVia']>
            id="dsh-code-remote-via"
            label={t('settings.remoteVia')}
            value={draft.remoteVia}
            onChange={(remoteVia) => { setDraft({ ...draft, remoteVia }) }}
            options={[
              { value: 'direct', label: t('settings.remoteVia.direct') },
              { value: 'aws-ssm', label: t('settings.remoteVia.awsSsm') },
              { value: 'azure-bastion', label: t('settings.remoteVia.azureBastion') },
            ]}
          />
        </SettingBlock>
        {draft.remoteVia === 'direct' && field('remoteHost')}
        {draft.remoteVia === 'aws-ssm' && (
          <>
            {field('remoteAwsInstanceId', t('settings.remoteVia.awsSsmHint'))}
            {field('remoteAwsRegion')}
            {field('remoteAwsProfile')}
          </>
        )}
        {draft.remoteVia === 'azure-bastion' && (
          <>
            {field('remoteAzureBastion', t('settings.remoteVia.azureBastionHint'))}
            {field('remoteAzureResourceGroup')}
            {field('remoteAzureVmId')}
            {field('remoteAzureSubscription')}
          </>
        )}
        {remoteOn && draft.remoteVia === 'direct' && (
          <SettingBlock label={t('settings.remoteNetwork')} hint={draft.remoteNetwork === 'private' ? t('settings.remoteNetwork.privateHint') : t('settings.remoteNetwork.publicHint')}>
            <SegmentedControl<CodeSettings['remoteNetwork']>
              id="dsh-code-remote-network"
              label={t('settings.remoteNetwork')}
              value={draft.remoteNetwork}
              onChange={(remoteNetwork) => { setDraft({ ...draft, remoteNetwork }) }}
              options={[
                { value: 'public', label: t('settings.remoteNetwork.public') },
                { value: 'private', label: t('settings.remoteNetwork.private') },
              ]}
            />
          </SettingBlock>
        )}
        {remoteOn && remoteLogin}
        {remoteOn && draft.remoteVia === 'direct' && draft.remoteNetwork === 'private' && field('remotePublicHost')}
        {remoteOn && draft.remoteVia === 'direct' && (
          <div style={{ display: 'grid', gap: 0 }}>
            <RestrictSsh remoteAddress={remoteAddress} detectAddress={detectAddress} saved={savedRemote} t={t} />
            {draft.remoteNetwork === 'public' && (
              <TailscaleJoinPanel
                join={tailscaleJoin}
                status={tailscaleStatus}
                saved={savedRemote}
                onUse={(address) => { setDraft({ ...draft, remotePublicHost: draft.remoteHost, remoteHost: address, remoteNetwork: 'private' }) }}
                t={t}
              />
            )}
          </div>
        )}
        {remoteOn && closePublic !== null && closePublic !== undefined && savedRemote && (
          <SettingBlock label={t('remote.closeTitle')} hint={t('remote.closeHint')}>
            <CommandBlock title={t('remote.azureClose')} lines={closePublic.azure} t={t} />
            <CommandBlock title={t('remote.awsClose')} lines={closePublic.aws} t={t} />
          </SettingBlock>
        )}
      </SettingsGroup>

      <SettingsGroup title={t('settings.group.advanced')}>
        {field('workerImage', t('settings.workerImageHint'))}
      </SettingsGroup>

      {/* Pinned to the bottom of the dialog, so Save is reachable from every group of a long page. */}
      <footer style={{ position: 'sticky', bottom: -24, zIndex: 1, display: 'flex', alignItems: 'center', gap: 12, padding: '12px 0 36px', marginTop: -16, marginBottom: -24, borderTop: divider, background: 'var(--dsw-alias-bg-layer-2)' }}>
        <Button type="submit" variant="primary" disabled={busy}>{t('settings.save')}</Button>
        {message !== null && <p style={text.hint} role="status" aria-live="polite">{message}</p>}
      </footer>
    </form>
  )
}

// ── Choice beside the + button (conversation.input.left) ───────────────────

/** Injected face of the repository label. */
export interface SelectionInjected {
  readonly hooks: { readonly view: HostObservable<CodeSessionView | null>; readonly presetIds: HostObservable<ReadonlySet<string>> }
  readonly sessionId: string
}

/**
 * `owner/name on branch` beside the composer's + button while a Code mode session has a choice and no
 * workspace yet. Gone once the first message starts the workspace.
 * @param props - injected state and translator.
 * @returns the label, or nothing.
 */
export function SelectionLabel({ useView, usePresetIds, sessionId, t }: InjectFace<SelectionInjected> & PropsLocale<typeof NS>): ReactNode {
  const view = useView(v => v)
  const codeMode = usePresetIds(ids => ids.has(sessionId))
  if (!codeMode || view === null || view.status !== 'pending') return null
  const text = t('selection.label', { repository: view.repository, branch: view.baseBranch })
  return (
    <span title={text} style={{ fontSize: 12, opacity: 0.7, alignSelf: 'center', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 280 }}>
      {text}
    </span>
  )
}

// ── Environment tab (conversation.view) ────────────────────────────────────

/** Injected face of the Environment tab. */
export interface EnvironmentTabInjected {
  readonly hooks: { readonly view: HostObservable<CodeSessionView | null>; readonly presetIds: HostObservable<ReadonlySet<string>> }
  readonly sessionId: string
  readonly load: () => Promise<Outcome<SessionEnvironment>>
  readonly usage: () => Promise<Outcome<WorkspaceUsage | null>>
  readonly variables: () => Promise<Outcome<SessionVariables>>
  readonly saveVariables: (lines: string[]) => Promise<Outcome<SessionVariables>>
  readonly grants: () => Promise<Outcome<string[]>>
  readonly revokeGrant: (host: string) => Promise<Outcome<string[]>>
  readonly overrides: () => Promise<Outcome<SessionOverridesView>>
  readonly saveOverrides: (overrides: SessionOverrides) => Promise<Outcome<SessionOverridesView>>
}

/** Default / On / Off choices for this session's overrides of Settings > Code. */
function SessionOverridesEditor({ load, save, t }: { readonly load: () => Promise<Outcome<SessionOverridesView>>; readonly save: (overrides: SessionOverrides) => Promise<Outcome<SessionOverridesView>>; readonly t: T }): ReactNode {
  const [view, setView] = useState<SessionOverridesView | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    void load().then((r) => { if (live) { if (r.ok) setView(r.value); else setMessage(t('error.generic', { error: r.message })) } })
    return () => { live = false }
  }, [load, t])
  if (view === null) return message === null ? null : <div style={note} role="alert">{message}</div>
  const choice = view.overrides.preview === undefined ? 'default' : view.overrides.preview ? 'on' : 'off'
  return (
    <section style={{ display: 'grid', gap: 8, maxWidth: 560 }}>
      <h3 style={tabHeading}>{t('env.sessionOptions')}</h3>
      <div style={{ ...row, justifyContent: 'space-between' }}>
        <span style={{ fontSize: 13, lineHeight: '20px' }}>{t('env.previewForSession')}</span>
        <SegmentedControl<'default' | 'on' | 'off'>
          id="dsh-code-session-preview"
          label={t('env.previewForSession')}
          value={choice}
          onChange={(next) => {
            const overrides: SessionOverrides = {
              ...view.overrides.isolatedBrowser === undefined ? {} : { isolatedBrowser: view.overrides.isolatedBrowser },
              ...next === 'default' ? {} : { preview: next === 'on' },
            }
            void save(overrides).then((r) => { if (r.ok) { setView(r.value); setMessage(null) } else setMessage(t('error.generic', { error: r.message })) })
          }}
          options={[
            { value: 'default', label: t('env.default', { value: view.defaults.preview ? t('env.on') : t('env.off') }) },
            { value: 'on', label: t('env.on') },
            { value: 'off', label: t('env.off') },
          ]}
        />
      </div>
      {view.effective.preview && (
        <div style={{ ...row, justifyContent: 'space-between' }}>
          <span style={{ fontSize: 13, lineHeight: '20px' }}>{t('env.isolatedForSession')}</span>
          {view.lockdown
            ? <span style={note}>{t('env.isolatedByLockdown')}</span>
            : (
              <SegmentedControl<'default' | 'on' | 'off'>
                id="dsh-code-session-isolated"
                label={t('env.isolatedForSession')}
                value={view.overrides.isolatedBrowser === undefined ? 'default' : view.overrides.isolatedBrowser ? 'on' : 'off'}
                onChange={(next) => {
                  const overrides: SessionOverrides = {
                    ...view.overrides.preview === undefined ? {} : { preview: view.overrides.preview },
                    ...next === 'default' ? {} : { isolatedBrowser: next === 'on' },
                  }
                  void save(overrides).then((r) => { if (r.ok) { setView(r.value); setMessage(null) } else setMessage(t('error.generic', { error: r.message })) })
                }}
                options={[
                  { value: 'default', label: t('env.default', { value: view.defaults.isolatedBrowser ? t('env.on') : t('env.off') }) },
                  { value: 'on', label: t('env.on') },
                  { value: 'off', label: t('env.off') },
                ]}
              />
            )}
        </div>
      )}
      {message !== null && <div style={note} role="alert">{message}</div>}
    </section>
  )
}

/**
 * This session's own variables, editable, beside the defaults it inherits. Saved values apply from the agent's
 * next command; a command already running keeps the values it started with.
 */
function SessionVariablesEditor({ variables, save, t }: { readonly variables: () => Promise<Outcome<SessionVariables>>; readonly save: (lines: string[]) => Promise<Outcome<SessionVariables>>; readonly t: T }): ReactNode {
  const [loaded, setLoaded] = useState<SessionVariables | null>(null)
  const [draft, setDraft] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let live = true
    void variables().then((r) => {
      if (!live) return
      if (r.ok) { setLoaded(r.value); setDraft(r.value.session.join('\n')) } else setMessage(t('error.generic', { error: r.message }))
    })
    return () => { live = false }
  }, [variables, t])
  return (
    <section style={{ display: 'grid', gap: 8 }}>
      <h3 style={tabHeading}>{t('env.variables')}</h3>
      {loaded !== null && loaded.defaults.length > 0 && (
        <div style={note}>
          {t('env.variablesDefaults')}
          <pre style={{ ...value, margin: '4px 0 0', fontSize: 12, whiteSpace: 'pre-wrap' }}>{loaded.defaults.join('\n')}</pre>
        </div>
      )}
      <textarea
        aria-label={t('env.variables')}
        rows={5}
        value={draft}
        placeholder="NODE_ENV=development"
        style={{ ...select, maxWidth: 'none', fontFamily: 'monospace' }}
        onChange={(event) => { setDraft(event.target.value) }}
      />
      <div style={note}>{t('env.variablesHint')}</div>
      <div style={row}>
        <Button
          size="sm"
          variant="primary"
          disabled={busy || loaded === null}
          onClick={() => {
            setBusy(true)
            setMessage(null)
            void save(draft.split('\n').map(x => x.trim()).filter(x => x !== '')).then((r) => {
              setBusy(false)
              if (r.ok) { setLoaded(r.value); setDraft(r.value.session.join('\n')); setMessage(t('settings.saved')) } else setMessage(t('error.generic', { error: r.message }))
            })
          }}
        >
          {t('settings.save')}
        </Button>
        {message !== null && <span style={note} role="status" aria-live="polite">{message}</span>}
      </div>
    </section>
  )
}

/** Hosts the user approved for this session (request_network_access), each with a Remove button. */
function NetworkGrantsList({ load, revoke, t }: { readonly load: () => Promise<Outcome<string[]>>; readonly revoke: (host: string) => Promise<Outcome<string[]>>; readonly t: T }): ReactNode {
  const [hosts, setHosts] = useState<string[] | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    void load().then((r) => {
      if (!live) return
      if (r.ok) setHosts(r.value)
      else setMessage(t('error.generic', { error: r.message }))
    })
    return () => { live = false }
  }, [load, t])
  return (
    <section style={{ display: 'grid', gap: 8 }}>
      <h3 style={tabHeading}>{t('env.approvedHosts')}</h3>
      {hosts !== null && hosts.length === 0 && <div style={note}>{t('env.approvedHostsNone')}</div>}
      {hosts !== null && hosts.map(host => (
        <div key={host} style={row}>
          <code style={value}>{host}</code>
          <Button
            size="sm"
            onClick={() => {
              setMessage(null)
              void revoke(host).then((r) => {
                if (r.ok) setHosts(r.value)
                else setMessage(t('error.generic', { error: r.message }))
              })
            }}
          >
            {t('env.approvedHostsRemove')}
          </Button>
        </div>
      ))}
      {message !== null && <span style={note} role="status" aria-live="polite">{message}</span>}
    </section>
  )
}

/**
 * The Environment tab beside Chat and Trajectory: where the session runs and, for a Code session, its account,
 * repository, branches, container, network and limits, the provisioning timeline and live resource usage.
 * @param props - injected loaders, state and translator.
 * @returns the tab content.
 */
export function EnvironmentTab({ useView, usePresetIds, sessionId, load, usage, variables, saveVariables, grants, revokeGrant, overrides, saveOverrides, t }: InjectFace<EnvironmentTabInjected> & PropsLocale<typeof NS>): ReactNode {
  const view = useView(v => v)
  const codeMode = usePresetIds(ids => ids.has(sessionId))
  const status = view?.status ?? (codeMode ? 'none' : 'host')
  return (
    <div style={{ padding: '16px 24px', overflow: 'auto', height: '100%', boxSizing: 'border-box' }}>
      <div style={{ maxWidth: 960, display: 'grid', gap: 24 }}>
        <EnvironmentPanel
          load={load}
          status={`${status}:${view?.repository ?? ''}:${view?.baseBranch ?? ''}:${String(codeMode)}`}
          side={view !== null && view.status !== 'pending' ? (
            <section>
              <h3 style={{ ...tabHeading, marginBottom: 8 }}>{t('resources.title')}</h3>
              <ResourcesBody usage={usage} t={t} />
            </section>
          ) : undefined}
          t={t}
        />
        {codeMode && <SessionOverridesEditor load={overrides} save={saveOverrides} t={t} />}
        {codeMode && <SessionVariablesEditor variables={variables} save={saveVariables} t={t} />}
        {codeMode && <NetworkGrantsList load={grants} revoke={revokeGrant} t={t} />}
      </div>
    </div>
  )
}

// ── Preview tab (conversation.view) ────────────────────────────────────────

/** Injected face of the Preview tab. */
export interface PreviewTabInjected {
  readonly hooks: { readonly view: HostObservable<CodeSessionView | null>; readonly presetIds: HostObservable<ReadonlySet<string>> }
  readonly sessionId: string
  readonly targets: () => Promise<Outcome<PreviewTargets>>
  readonly open: (port: number) => Promise<Outcome<string>>
  readonly mode: () => Promise<Outcome<SessionOverridesView>>
  readonly frame: (port: number, after: number) => Promise<Outcome<IsolatedFrame | null>>
  readonly input: (action: BrowserAction) => Promise<Outcome<boolean>>
  readonly stop: () => Promise<Outcome<void>>
}

const MODIFIER_BITS = (event: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): number =>
  (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0)

/**
 * The isolated browser: Chromium runs inside the workspace and this view shows its screencast frames, forwarding
 * mouse, wheel and keyboard input. No page code runs in the viewer's browser.
 */
function IsolatedView({ port, frame, input, stop, t }: {
  readonly port: number
  readonly frame: (port: number, after: number) => Promise<Outcome<IsolatedFrame | null>>
  readonly input: (action: BrowserAction) => Promise<Outcome<boolean>>
  readonly stop: () => Promise<Outcome<void>>
  readonly t: T
}): ReactNode {
  const [picture, setPicture] = useState<IsolatedFrame | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [box, setBox] = useState<HTMLDivElement | null>(null)
  const [image, setImage] = useState<HTMLImageElement | null>(null)
  // Long-poll frames while mounted.
  useEffect(() => {
    let live = true
    let seq = 0
    const loop = async (): Promise<void> => {
      while (live) {
        const r = await frame(port, seq)
        if (!live) return
        if (!r.ok) { setError(r.message); await new Promise(res => setTimeout(res, 2000)); continue }
        setError(null)
        if (r.value !== null) { seq = r.value.seq; setPicture(r.value) }
      }
    }
    void loop()
    return () => { live = false }
  }, [port, frame])
  useEffect(() => () => { void stop() }, [stop])
  // Follow the tab's size.
  useEffect(() => {
    if (box === null) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const observer = new ResizeObserver(([entry]) => {
      if (entry === undefined) return
      clearTimeout(timer)
      timer = setTimeout(() => { void input({ kind: 'resize', width: Math.round(entry.contentRect.width), height: Math.round(entry.contentRect.height) }) }, 250)
    })
    observer.observe(box)
    return () => { observer.disconnect(); clearTimeout(timer) }
  }, [box, input])
  const point = (event: { clientX: number; clientY: number }): { x: number; y: number } | undefined => {
    if (image === null || picture === null) return undefined
    const rect = image.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return undefined
    return { x: (event.clientX - rect.left) * (picture.width / rect.width), y: (event.clientY - rect.top) * (picture.height / rect.height) }
  }
  const button = (b: number): 'left' | 'middle' | 'right' => b === 1 ? 'middle' : b === 2 ? 'right' : 'left'
  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <div style={{ ...row, padding: '6px 12px', borderBottom: '1px solid var(--dsw-alias-border-default, rgba(127,127,127,.25))' }}>
        <Button size="sm" variant="outline" onClick={() => { void input({ kind: 'history', action: 'back' }) }}>{t('previewTab.back')}</Button>
        <Button size="sm" variant="outline" onClick={() => { void input({ kind: 'history', action: 'forward' }) }}>{t('previewTab.forward')}</Button>
        <Button size="sm" variant="outline" onClick={() => { void input({ kind: 'history', action: 'reload' }) }}>{t('previewTab.reload')}</Button>
        <span style={{ ...note, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{picture?.url ?? ''}</span>
        <span style={note}>{t('previewTab.isolatedBrowser')}</span>
      </div>
      {error !== null && <div style={{ ...note, padding: 12 }} role="alert">{t('error.generic', { error })}</div>}
      <div
        ref={setBox}
        tabIndex={0}
        style={{ flex: 1, minHeight: 0, overflow: 'hidden', outline: 'none', background: '#fff', position: 'relative' }}
        onKeyDown={(event) => {
          event.preventDefault()
          const printable = event.key.length === 1 && !event.ctrlKey && !event.metaKey
          void input({ kind: 'key', event: 'keyDown', key: event.key, code: event.code, text: printable ? event.key : event.key === 'Enter' ? '\r' : '', keyCode: event.keyCode, modifiers: MODIFIER_BITS(event) })
        }}
        onKeyUp={(event) => {
          event.preventDefault()
          void input({ kind: 'key', event: 'keyUp', key: event.key, code: event.code, text: '', keyCode: event.keyCode, modifiers: MODIFIER_BITS(event) })
        }}
      >
        {picture === null
          ? <div style={{ ...note, padding: 16 }}>{t('previewTab.starting')}</div>
          : (
            <img
              ref={setImage}
              alt={t('previewTab.frameTitle', { port: String(port) })}
              src={`data:image/jpeg;base64,${picture.image}`}
              draggable={false}
              style={{ display: 'block', maxWidth: '100%', maxHeight: '100%', userSelect: 'none' }}
              onContextMenu={(event) => { event.preventDefault() }}
              onMouseDown={(event) => {
                event.preventDefault()
                box?.focus()
                const p = point(event)
                if (p !== undefined) void input({ kind: 'mouse', event: 'mousePressed', ...p, button: button(event.button), clickCount: event.detail || 1, modifiers: MODIFIER_BITS(event) })
              }}
              onMouseUp={(event) => {
                const p = point(event)
                if (p !== undefined) void input({ kind: 'mouse', event: 'mouseReleased', ...p, button: button(event.button), clickCount: event.detail || 1, modifiers: MODIFIER_BITS(event) })
              }}
              onMouseMove={(event) => {
                const p = point(event)
                if (p !== undefined && event.buttons === 0) void input({ kind: 'mouse', event: 'mouseMoved', ...p, button: 'none', clickCount: 0, modifiers: MODIFIER_BITS(event) })
              }}
              onWheel={(event) => {
                const p = point(event)
                if (p !== undefined) void input({ kind: 'wheel', ...p, deltaX: event.deltaX, deltaY: event.deltaY, modifiers: MODIFIER_BITS(event) })
              }}
            />
          )}
      </div>
    </div>
  )
}

/** The same capabilities the preview response grants through its CSP; never allow-same-origin. */
const PREVIEW_SANDBOX = 'allow-scripts allow-forms allow-popups allow-modals allow-downloads'

/**
 * The app running in the Code workspace, embedded in this browser. It loads through the authenticated preview
 * route (Harness to container, never the other way), in a sandboxed frame with an opaque origin, so the page
 * cannot reach the dsh page, its storage or its token. Ports are found from what the workspace listens on.
 * @param props - injected loaders, state and translator.
 * @returns the preview.
 */
export function PreviewTab({ useView, usePresetIds, sessionId, targets, open, mode, frame, input, stop, t }: InjectFace<PreviewTabInjected> & PropsLocale<typeof NS>): ReactNode {
  const view = useView(v => v)
  const codeMode = usePresetIds(ids => ids.has(sessionId))
  const ready = view !== null && view.status === 'ready'
  const [list, setList] = useState<PreviewTargets | null>(null)
  const [port, setPort] = useState<number | null>(null)
  const [src, setSrc] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [frameKey, setFrameKey] = useState(0)
  const [isolated, setIsolated] = useState<boolean | null>(null)
  useEffect(() => {
    let live = true
    const check = (): void => { void mode().then((r) => { if (live && r.ok) setIsolated(r.value.effective.preview && r.value.effective.isolatedBrowser) }) }
    check()
    const timer = setInterval(check, 5000)
    return () => { live = false; clearInterval(timer) }
  }, [mode])
  useEffect(() => {
    if (!ready) return
    let live = true
    const tick = (): void => {
      void targets().then((r) => {
        if (!live) return
        if (r.ok) setList(r.value)
        else setError(r.message)
      })
    }
    tick()
    const timer = setInterval(tick, 3000)
    return () => { live = false; clearInterval(timer) }
  }, [ready, targets])
  const openable = (list?.targets ?? []).filter(p => p.listening && p.allowed)
  // Pick the first open port by itself; keep the user's choice while it stays open.
  useEffect(() => {
    if (port !== null && openable.some(p => p.port === port)) return
    setPort(openable[0]?.port ?? null)
  }, [openable.map(p => p.port).join(','), port])
  useEffect(() => {
    if (port === null || isolated !== false) { setSrc(null); return }
    let live = true
    setError(null)
    void open(port).then((r) => {
      if (!live) return
      if (r.ok) setSrc(r.value)
      else { setSrc(null); setError(r.message) }
    })
    return () => { live = false }
  }, [port, open, isolated])
  if (!codeMode) return <div style={{ ...note, padding: 16 }}>{t('previewTab.notCode')}</div>
  if (!ready) return <div style={{ ...note, padding: 16 }}>{t('previewTab.notReady')}</div>
  if (error !== null && /Preview is off/.test(error)) return <div style={{ ...note, padding: 16 }}>{t('previewTab.off')}</div>
  const blocked = (list?.targets ?? []).filter(p => !(p.listening && p.allowed))
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{ ...row, padding: '8px 12px', borderBottom: '1px solid var(--dsw-alias-border-default, rgba(127,127,127,.25))' }}>
        {openable.map(p => (
          <Button key={p.port} size="sm" variant={p.port === port ? 'primary' : 'outline'} onClick={() => { setPort(p.port) }}>{`:${p.port}`}</Button>
        ))}
        {port !== null && isolated === false && <Button size="sm" variant="outline" onClick={() => { setFrameKey(k => k + 1) }}>{t('previewTab.reload')}</Button>}
        {blocked.map(p => (
          <span key={p.port} style={note}>{`:${p.port} ${!p.allowed ? t('preview.notAllowed') : t('preview.notRunning')}`}</span>
        ))}
        <span style={{ ...note, marginLeft: 'auto' }}>{isolated === true ? t('previewTab.isolatedBrowser') : t('previewTab.isolated')}</span>
      </div>
      {error !== null && <div style={{ ...note, padding: 12 }} role="alert">{t('error.generic', { error })}</div>}
      {isolated === true && port !== null
        ? <IsolatedView key={port} port={port} frame={frame} input={input} stop={stop} t={t} />
        : src === null
        ? <div style={{ ...note, padding: 16 }}>{list === null ? t('picker.loading') : t('preview.nothingListening')}</div>
        : (
          <iframe
            key={`${src}#${frameKey}`}
            title={t('previewTab.frameTitle', { port: String(port) })}
            src={src}
            sandbox={PREVIEW_SANDBOX}
            referrerPolicy="no-referrer"
            style={{ flex: 1, width: '100%', border: 0, background: '#fff' }}
          />
        )}
    </div>
  )
}
