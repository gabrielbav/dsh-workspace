/**
 * Workspace lifecycle for Code sessions, independent of Harness: gVisor
 * validation, the internal network and egress proxy, per-session checkout
 * and container provisioning, in-container Git status, reconciliation after
 * restarts, and cleanup. One session owns exactly one workspace and one
 * container; the logical session id is never the container id.
 */
import { chown, constants, cp, lchown, mkdir, open, readFile, rm, writeFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { execFile as execFileCb } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { DockerCli } from './docker.ts'
import { CACHE_TARGET, createArgs, execArgs, INSTALLATION_LABEL, OWNER_LABEL, REQUIRED_RUNTIME, SESSION_LABEL, VOLUME_KIND_LABEL, WORKSPACE_LABEL, type CheckoutStorage, type ResourceLimits } from './container-spec.ts'
import { unsafeFolderReason } from './mounts.ts'
import { Git, workingBranchName } from './git.ts'
import type { RepositoryRef, SelfTestCheck, SelfTestReport, WorkspaceStatus, WorkspaceUsage } from '../types.ts'

export type { SelfTestReport, WorkspaceStatus } from '../types.ts'
import type { EgressPolicy } from '../egress/policy.ts'
import { closeConnection, pinHostKey, PREPARE_SCRIPT, remoteShell, RemoteError, stopBastionTunnel, type RemoteHost } from './remote.ts'
import { isPrivateAddress, isTailscaleAddress, localTailscaleAddresses, parseSshClient, probeTcp, type RemoteNetwork } from './network-path.ts'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

/** Durable workspace record, stored as JSON in the data directory. */
export interface WorkspaceRecord {
  readonly workspaceId: string
  readonly sessionId: string
  readonly repository: RepositoryRef
  /** GitHub account that clones and pushes; absent means the gh CLI's active account. */
  readonly account?: string
  readonly baseBranch: string
  readonly baseCommit: string
  readonly workingBranch: string
  /** Sandbox options the current container was created with. */
  options?: WorkspaceOptions
  /** Where the checkout lives; records from before volumes have none and are `bind`. */
  readonly storage?: CheckoutStorage
  /** The checkout's Docker volume when {@link storage} is `volume`. */
  readonly volume?: string
  /** The Docker host the workspace lives on: `local`, or `ssh-key:<SHA256 host key>` for a remote VM; absent means `local`. */
  readonly backend?: string
  readonly path: string
  readonly mirrorPath: string
  readonly containerName: string
  readonly image: string
  readonly runtime: typeof REQUIRED_RUNTIME
  status: WorkspaceStatus
  error?: string
  readonly createdAt: string
  updatedAt: string
}

/** Relay run by `node -e` inside the container: stdin/stdout <-> 127.0.0.1:<port>. */
const PREVIEW_RELAY = "const s=require('net').connect(+process.argv[1],'127.0.0.1');process.stdin.pipe(s);s.pipe(process.stdout);s.on('error',()=>process.exit(1));s.on('close',()=>process.exit(0));process.stdin.on('end',()=>s.end())"

/** One TCP port a workspace process listens on. */
export interface ListeningPort {
  readonly port: number
  /** Bound to 127.0.0.1 or ::1 only, so the preview, which reaches the container over its network, cannot connect. */
  readonly localOnly: boolean
}

/**
 * Listening sockets from /proc/net/tcp and /proc/net/tcp6 text (state 0A).
 * @param text - the concatenated files.
 * @returns one entry per port; local-only when every socket on it is loopback-bound.
 */
export function parseListeningPorts(text: string): ListeningPort[] {
  const ports = new Map<number, boolean>()
  for (const line of text.split('\n')) {
    const fields = line.trim().split(/\s+/)
    if (fields.length < 4 || fields[3] !== '0A') continue
    const [address, hexPort] = (fields[1] ?? '').split(':')
    const port = Number.parseInt(hexPort ?? '', 16)
    if (!Number.isInteger(port) || port <= 0 || address === undefined) continue
    // Little-endian hex: 127.x.x.x ends in 7F; ::1 is 0...01000000; ::ffff:127.x is 0000000000000000FFFF0000xx00007F.
    const loopback = (address.length === 8 && address.endsWith('7F')) || address === '00000000000000000000000001000000' || /^0000000000000000FFFF0000[0-9A-F]{6}7F$/i.test(address)
    ports.set(port, (ports.get(port) ?? true) && loopback)
  }
  return [...ports].map(([port, localOnly]) => ({ port, localOnly })).sort((a, b) => a.port - b.port)
}

/** Sandbox options applied when a workspace container is created. */
export interface WorkspaceOptions {
  readonly readOnlyWorkspace: boolean
  /** Host folder of this repository's dependency cache, when the cache is on. */
  readonly cacheDir?: string
  /** Docker volume of this repository's dependency cache, for a checkout kept in a volume. */
  readonly cacheVolume?: string
  readonly readOnlyFolders: readonly string[]
  readonly shmMb: number
  readonly lockdown: boolean
}

/** Deployment configuration for the manager. */
export interface WorkspaceManagerConfig {
  /** Root for workspaces, mirrors and records; must be outside any home dotfolder. */
  readonly dataDir: string
  /** Worker image reference, pinned by digest in production. */
  image: string
  /** Directory holding the worker Dockerfile and file helper, for guided builds. */
  readonly workerDir?: string
  /** Egress proxy image (runs the bundled proxy script). */
  readonly proxyImage: string
  /** Absolute host directory holding the egress proxy sources (`entry.ts`, `proxy.ts`, `policy.ts`). */
  readonly proxyDir: string
  limits: ResourceLimits
  policy: EgressPolicy
  /** Container uid/gid; must not be 0. */
  readonly uid: number
  readonly gid: number
  /** Maximum concurrent workspaces on this host. */
  maxWorkspaces: number
  /** Container ports the user may preview through the authenticated Harness route. */
  previewPorts: readonly number[]
  /** New `dsh-code/<hash>` branch per session (default); false works on the base branch itself. */
  newBranch?: boolean
  /** Mount checkouts read-only. */
  readOnlyWorkspace?: boolean
  /** Keep a dependency cache per repository under dataDir/caches. */
  dependencyCache?: boolean
  /** Extra host folders mounted read-only at the same path. */
  readOnlyFolders?: readonly string[]
  /** /dev/shm size in MB; 256 when unset. */
  shmMb?: number
  /** Forces a read-only workspace, no cache and no extra folders (network none is applied through the policy). */
  lockdown?: boolean
  /**
   * Where new checkouts live: `auto` (default) uses a host folder when the sandbox user can write one on this
   * Docker host and a Docker volume otherwise; `bind` and `volume` force one. Existing workspaces keep theirs.
   */
  storage?: 'auto' | CheckoutStorage
  /**
   * Run sandboxes on a remote Docker host over SSH instead of this computer. `dockerBinary` is the generated wrapper
   * ({@link writeRemoteFiles}); `dir` holds Code's SSH config and pinned host key. Checkouts are then always volumes,
   * extra read-only folders are skipped (they are on this computer), and the proxy's code and policy live in volumes.
   */
  readonly remote?: {
    readonly host: RemoteHost
    readonly dir: string
    readonly dockerBinary: string
    /** `private`: the host is a Tailscale or WireGuard address and public SSH should be closed. */
    readonly network?: RemoteNetwork
    /** The VM's public address, checked from here to be unreachable when `network` is `private`. */
    readonly publicHost?: string
  }
  /** Remote settings that could not be used: the self test reports it and no new workspace starts anywhere. */
  readonly remoteError?: string
  /** Whether the Harness sandbox mode of a session is read-only (its permission selector); read at container creation. */
  sessionReadOnly?: (sessionId: string) => boolean
  /** Default variables for every workspace; a session's own values override them by name. */
  environment?: Readonly<Record<string, string>>
  /**
   * Prefix of every Docker name and the owner label value this manager uses. Two managers with
   * different namespaces never see or remove each other's containers and networks (the live tests
   * rely on this). Defaults to `dsh-code`, which keeps the names and labels of existing installs.
   */
  readonly namespace?: string
}

/** Structured failure with a user-actionable code. */
export class WorkspaceError extends Error {
  /**
   * @param code - stable failure code.
   * @param message - localized-by-caller detail.
   */
  constructor(readonly code: 'gvisor-unavailable' | 'docker-unavailable' | 'limit-reached' | 'not-found' | 'provision-failed' | 'unsafe-state', message: string) {
    super(message)
    this.name = 'WorkspaceError'
  }
}

/** Network and proxy names. Fixed: they are the isolation invariant's anchors. */
/** Default namespace; its owner label value stays `1` so earlier installs keep their containers. */
export const DEFAULT_NAMESPACE = 'dsh-code'
export const PROXY_PORT = 3128
/** Label on the proxy container: a hash of the code it runs. */
export const PROXY_VERSION_LABEL = 'dsh-code.proxy-version'

/**
 * Hash the proxy's code as copied into the data directory.
 * @param dir - the proxy source folder.
 * @returns a short hex digest of every file's name and contents.
 */
export async function proxyCodeHash(dir: string): Promise<string> {
  const hash = createHash('sha256')
  for (const file of (await readdir(dir, { recursive: true })).map(String).sort()) {
    const path = join(dir, file)
    if (!statSync(path).isFile()) continue
    hash.update(file).update('\0').update(await readFile(path)).update('\0')
  }
  return hash.digest('hex').slice(0, 16)
}

/** The proxy polls policy.json every second; waiting this long guarantees a reload. */
export const POLICY_RELOAD_MS = 1500

/** Owns workspace records and their Docker resources. */
export class WorkspaceManager {
  private readonly records = new Map<string, WorkspaceRecord>()
  private readonly pending = new Map<string, Promise<WorkspaceRecord>>()

  /**
   * @param config - deployment configuration.
   * @param docker - Docker CLI.
   * @param git - host Git.
   */
  constructor(
    readonly config: WorkspaceManagerConfig,
    private readonly docker = new DockerCli(),
    private readonly git = new Git(),
    /** Host-only environment that makes git act as one GitHub account; never reaches a workspace. */
    private readonly credentials: (account: string) => Promise<Readonly<Record<string, string>>> = async () => ({}),
  ) {
    if (config.uid === 0 || config.gid === 0) throw new WorkspaceError('unsafe-state', 'workspace uid/gid must not be 0')
    this.installationId = installationIdOf(config.dataDir)
  }

  /** Random id of this data folder (dataDir/installation-id), on every container and volume it creates. */
  readonly installationId: string

  /** On a remote host the default namespace is this installation's own, so installations sharing a VM share nothing. */
  private get namespace(): string { return this.config.namespace ?? (this.config.remote === undefined ? DEFAULT_NAMESPACE : `dsh-code-${this.installationId.slice(0, 8)}`) }
  private get owner(): string { return this.namespace === DEFAULT_NAMESPACE ? '1' : this.namespace }
  /** Internal network: workers and the proxy only, no route out. */
  get internalNetwork(): string { return `${this.namespace}-internal` }
  /** Network the proxy uses to reach the outside. */
  get egressNetwork(): string { return `${this.namespace}-egress-out` }
  /** The egress proxy container, also its DNS alias on the internal network. */
  get proxyContainer(): string { return `${this.namespace}-egress` }
  private get recordsDir(): string { return join(this.config.dataDir, 'records') }
  private get policyPath(): string { return join(this.config.dataDir, 'egress', 'policy.json') }
  /**
   * The proxy's code, copied into the data directory before each start. The Docker host may not see the
   * plugin's install folder (on macOS, a Colima VM cannot read ~/Documents), but it must see dataDir for
   * the workspaces anyway. The copy is outside `workspaces/`, so no sandbox can write to it.
   */
  private get proxySourceDir(): string { return join(this.config.dataDir, 'proxy') }
  /** The `docker` to spawn for workspace processes: the remote wrapper, or `docker`. */
  get dockerBinary(): string { return this.config.remote?.dockerBinary ?? 'docker' }
  /**
   * Which Docker host this manager drives; records of another one are left alone. A remote VM is named by its
   * pinned host key, not its address, so reaching the same VM another way (its Tailscale address, a tunnel, a new
   * public IP) keeps its sessions.
   */
  get backend(): string {
    const remote = this.config.remote?.host
    return remote === undefined ? 'local' : `ssh-key:${remote.hostKey}`
  }
  private onOtherBackend(record: WorkspaceRecord): boolean { return (record.backend ?? 'local') !== this.backend }
  private get proxyCodeVolume(): string { return `${this.namespace}-proxy-code` }
  private get policyVolume(): string { return `${this.namespace}-policy` }

  /**
   * Run the mandatory checks. Code stays disabled unless every check passes.
   * @returns the report.
   */
  async selfTest(): Promise<SelfTestReport> {
    const checks: SelfTestCheck[] = []
    if (this.config.remoteError !== undefined) return { ok: false, checks: [{ id: 'remote', ok: false, detail: this.config.remoteError, remedy: SETUP_REMEDIES.remote }] }
    const remote = this.config.remote
    if (remote !== undefined) {
      const connection = await this.checkRemote()
      checks.push(connection)
      if (!connection.ok) return { ok: false, checks }
      const network = await this.privateNetworkChecks()
      checks.push(...network)
      if (network.some(c => !c.ok)) return { ok: false, checks }
    }
    const runtimes = await this.docker.runtimes()
    checks.push(runtimes.length > 0
      ? { id: 'docker', ok: true, detail: 'Docker daemon reachable' }
      : remote !== undefined
        ? { id: 'docker', ok: false, detail: 'Docker is not installed or not reachable on the remote VM', remedy: SETUP_REMEDIES.remotePrepare, action: 'prepare-remote' as const }
        : { id: 'docker', ok: false, detail: 'Docker daemon not reachable', remedy: SETUP_REMEDIES.docker })
    if (runtimes.length === 0) return { ok: false, checks }
    const hasRunsc = runtimes.includes(REQUIRED_RUNTIME)
    checks.push(hasRunsc
      ? { id: 'runtime', ok: true, detail: 'runsc runtime registered' }
      : { id: 'runtime', ok: false, detail: 'runsc runtime is not registered with Docker', ...remote === undefined ? { remedy: SETUP_REMEDIES.runtime } : { remedy: SETUP_REMEDIES.remotePrepare, action: 'prepare-remote' as const } })
    const image = await this.docker.tryExec(['image', 'inspect', '--format', '{{.Id}}', this.config.image])
    checks.push(image.code === 0
      ? { id: 'image', ok: true, detail: `worker image ${this.config.image} present (${image.stdout.trim().slice(0, 19)})` }
      : { id: 'image', ok: false, detail: `worker image ${this.config.image} is missing`, remedy: SETUP_REMEDIES.image(this.config.image), ...(this.config.workerDir === undefined ? {} : { action: 'build-worker' as const }) })
    if (hasRunsc && image.code === 0) {
      const probe = await this.docker.tryExec(['run', '--rm', '--runtime', REQUIRED_RUNTIME, '--network', 'none', this.config.image, 'sh', '-c', 'dmesg 2>/dev/null | head -n 3; id -u'])
      const isolated = probe.code === 0 && /gVisor/i.test(probe.stdout)
      checks.push({ id: 'isolation', ok: isolated, detail: isolated ? 'container kernel is gVisor' : `gVisor probe failed: ${probe.stderr.trim() || probe.stdout.trim()}`, ...(isolated ? {} : { remedy: SETUP_REMEDIES.runtime }) })
      // Host folders matter only when Docker runs on this computer.
      if (remote === undefined) {
        await mkdir(join(this.config.dataDir, 'workspaces'), { recursive: true })
        const reach = await this.docker.tryExec(['run', '--rm', '--runtime', REQUIRED_RUNTIME, '--network', 'none', '--user', `${this.config.uid}:${this.config.gid}`,
          '--mount', `type=bind,source=${join(this.config.dataDir, 'workspaces')},target=/probe,readonly`, this.config.image, 'ls', '/probe'])
        checks.push(reach.code === 0
          ? { id: 'data-dir', ok: true, detail: 'workspace folder is reachable by the container user' }
          : { id: 'data-dir', ok: false, detail: `the container user ${this.config.uid} cannot reach ${this.config.dataDir}`, remedy: SETUP_REMEDIES.dataDir })
      }
      this.storageChoice = this.probeStorage()
      const storage = await this.storageChoice
      checks.push(storage === undefined
        ? { id: 'writable', ok: false, detail: 'the sandbox user can write neither a host folder nor a Docker volume', remedy: SETUP_REMEDIES.dataDir }
        : remote !== undefined
          ? { id: 'writable', ok: true, detail: 'checkouts live in Docker volumes on the remote VM' }
          : storage === 'bind'
          ? { id: 'writable', ok: true, detail: 'checkouts live in host folders the sandbox user can write' }
          : this.config.storage === 'bind'
            ? { id: 'writable', ok: true, warning: true, detail: 'the sandbox user cannot write host folders on this Docker host', remedy: SETUP_REMEDIES.storage }
            : { id: 'writable', ok: true, detail: 'checkouts live in Docker volumes: the sandbox user cannot write host folders on this Docker host' })
      const tools = await this.docker.tryExec(['run', '--rm', '--runtime', REQUIRED_RUNTIME, '--network', 'none', '--user', `${this.config.uid}:${this.config.gid}`, this.config.image,
        'sh', '-c', `command -v git && command -v bash && command -v rg && node --version && test -r ${FS_HELPER}`])
      checks.push(tools.code === 0
        ? { id: 'worker', ok: true, detail: 'worker image has git, bash, ripgrep, Node and the file helper' }
        : { id: 'worker', ok: false, detail: 'worker image lacks git, bash, ripgrep, Node or the file helper', remedy: SETUP_REMEDIES.image(this.config.image), ...(this.config.workerDir === undefined ? {} : { action: 'build-worker' as const }) })
    }
    return { ok: checks.every(c => c.ok), checks }
  }

  /**
   * Pin the VM's host key and log in once. Fails with the reason (no answer, a different host key, the key file
   * refused) and how to fix it.
   */
  private async checkRemote(): Promise<SelfTestCheck> {
    const remote = this.config.remote!
    try {
      await pinHostKey(remote.dir, remote.host)
    } catch (error) {
      return { id: 'remote', ok: false, detail: error instanceof Error ? error.message : String(error), remedy: SETUP_REMEDIES.remote }
    }
    const login = await remoteShell(remote.dir, 'uname -sm')
    if (login.code !== 0) {
      // The next attempt opens a fresh Bastion tunnel instead of reusing a dead one.
      if (remote.host.via?.kind === 'azure-bastion') stopBastionTunnel(remote.dir)
      // Over a tailnet, the usual cause is this computer not being on it.
      const offTailnet = remote.network === 'private' && isTailscaleAddress(remote.host.host) && localTailscaleAddresses().length === 0
      return { id: 'remote', ok: false, detail: `SSH login to the remote VM failed: ${login.stderr.trim().split('\n').slice(-1)[0] ?? 'no output'}`, remedy: offTailnet ? SETUP_REMEDIES.tailnet : SETUP_REMEDIES.remote }
    }
    return { id: 'remote', ok: true, detail: `remote VM reachable over SSH, host key pinned (${login.stdout.trim()})` }
  }

  /**
   * Private network checks after a successful login: the host must be a private address, and the VM's public SSH
   * should not answer from here. "Not reachable from this computer" is all Code can tell; a firewall may still let
   * others in, so the check never says "closed".
   * @returns the checks, empty in public mode.
   */
  private async privateNetworkChecks(): Promise<SelfTestCheck[]> {
    const remote = this.config.remote
    if (remote?.network !== 'private') return []
    const checks: SelfTestCheck[] = []
    const host = remote.host.host
    const addresses = isIP(host) !== 0 ? [host] : (await lookup(host, { all: true }).catch(() => [])).map(a => a.address)
    checks.push(addresses.length > 0 && addresses.every(isPrivateAddress)
      ? { id: 'private-network', ok: true, detail: 'the VM is reached at a private network address' }
      : { id: 'private-network', ok: false, detail: 'Private network is chosen, but the host is not a private address', remedy: SETUP_REMEDIES.privateHost })
    if (remote.publicHost !== undefined && remote.publicHost !== '') {
      const open = await probeTcp(remote.publicHost, remote.host.port)
      checks.push(open
        ? { id: 'public-ssh', ok: true, warning: true, detail: 'the VM\'s public SSH port still answers from this computer', remedy: SETUP_REMEDIES.closePublic }
        : { id: 'public-ssh', ok: true, detail: 'the VM\'s public SSH port does not answer from this computer (a firewall may still let others in)' })
    }
    return checks
  }

  /**
   * The address the VM sees for this dsh (`$SSH_CLIENT`), for a firewall rule that allows only it.
   * @returns the address.
   */
  async remoteClientAddress(): Promise<string> {
    const remote = this.config.remote
    if (remote === undefined) throw new WorkspaceError('not-found', 'no remote Docker host is configured')
    await this.ensurePinned()
    const result = await remoteShell(remote.dir, 'printf "%s\\n" "$SSH_CLIENT"')
    const address = result.code === 0 ? parseSshClient(result.stdout) : undefined
    if (address === undefined) throw new WorkspaceError('provision-failed', 'the VM did not report the address it sees for this computer')
    return address
  }

  /**
   * Install Docker and gVisor on the remote VM and give the login Docker access ({@link PREPARE_SCRIPT}). Runs only
   * on the user's request from the setup notice; needs passwordless sudo on the VM.
   * @returns the script's output.
   */
  async prepareRemote(): Promise<string> {
    const remote = this.config.remote
    if (remote === undefined) throw new WorkspaceError('not-found', 'no remote Docker host is configured')
    await pinHostKey(remote.dir, remote.host).catch((error: unknown) => { throw new WorkspaceError('unsafe-state', error instanceof RemoteError ? error.message : String(error)) })
    const result = await remoteShell(remote.dir, 'sh -s', PREPARE_SCRIPT, 15 * 60_000)
    // A new login picks up the docker group.
    await closeConnection(remote.dir)
    const log = `${result.stdout}\n${result.stderr}`.trim().split('\n').slice(-20).join('\n')
    if (result.code !== 0) throw new WorkspaceError('provision-failed', `preparing the remote VM failed:\n${log}`)
    return log
  }

  /** On a remote host, pin the host key when it is not pinned yet (SSH refuses the VM until then). */
  private async ensurePinned(): Promise<void> {
    const remote = this.config.remote
    if (remote === undefined) return
    const pinned = await readFile(join(remote.dir, 'known_hosts'), 'utf8').catch(() => '')
    if (pinned.trim() === '') await pinHostKey(remote.dir, remote.host)
  }

  /** Result of the last storage probe, shared by provisioning and the self test. */
  private storageChoice: Promise<CheckoutStorage | undefined> | undefined

  /** Labels on every volume this manager owns. */
  private volumeLabels(kind: 'checkout' | 'cache' | 'probe' | 'proxy', workspaceId?: string): string[] {
    return [`${OWNER_LABEL}=${this.owner}`, `${INSTALLATION_LABEL}=${this.installationId}`, `${VOLUME_KIND_LABEL}=${kind}`, ...workspaceId === undefined ? [] : [`${WORKSPACE_LABEL}=${workspaceId}`]]
  }

  /** A short-lived trusted container on one volume: gVisor, no network, no capabilities unless named. */
  private oneShot(volume: string, target: string, user: string, caps: readonly string[], interactive: boolean): string[] {
    return ['run', '--rm', ...interactive ? ['-i'] : [], '--runtime', REQUIRED_RUNTIME, '--network', 'none', '--user', user,
      '--cap-drop', 'ALL', ...caps.flatMap(c => ['--cap-add', c]), '--security-opt', 'no-new-privileges', '--read-only',
      '--tmpfs', '/tmp:rw,nosuid,nodev,size=64m', '--env', 'HOME=/tmp', '--label', `${OWNER_LABEL}=${this.owner}`,
      '--mount', `type=volume,source=${volume},target=${target}`, this.config.image]
  }

  /**
   * Create a volume and give its root to the sandbox user. The chown runs once, in gVisor, with only CAP_CHOWN, on
   * an empty volume: nothing of the repository exists yet.
   */
  private async createOwnedVolume(volume: string, target: string, labels: readonly string[]): Promise<void> {
    if (!(await this.docker.ensureVolume(volume, labels))) return
    await this.docker.exec([...this.oneShot(volume, target, '0:0', ['CHOWN'], false), 'chown', `${this.config.uid}:${this.config.gid}`, target])
  }

  /**
   * Which storage this Docker host supports for the sandbox user: a host folder first, then a Docker volume.
   * @returns the first that works, or undefined when neither does.
   */
  private async probeStorage(): Promise<CheckoutStorage | undefined> {
    const user = `${this.config.uid}:${this.config.gid}`
    const write = 'mkdir -p /probe/d/e && echo ok > /probe/d/e/f && rm -r /probe/d'
    if (this.config.storage !== 'volume' && this.config.remote === undefined) {
      const dir = join(this.config.dataDir, 'workspaces', `.write-probe-${randomUUID().slice(0, 8)}`)
      await mkdir(dir, { recursive: true })
      await chownTree(dir, this.config.uid, this.config.gid)
      try {
        const bind = await this.docker.tryExec(['run', '--rm', '--runtime', REQUIRED_RUNTIME, '--network', 'none', '--user', user,
          '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--read-only',
          '--mount', `type=bind,source=${dir},target=/probe`, this.config.image, 'sh', '-c', write])
        if (bind.code === 0) return 'bind'
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    }
    const volume = `${this.namespace}-probe-${randomUUID().slice(0, 8)}`
    try {
      await this.createOwnedVolume(volume, '/probe', this.volumeLabels('probe'))
      const probe = await this.docker.tryExec([...this.oneShot(volume, '/probe', user, [], false), 'sh', '-c', write])
      return probe.code === 0 ? 'volume' : undefined
    } catch {
      return undefined
    } finally {
      await this.docker.removeVolume(volume).catch(() => undefined)
    }
  }

  /** Storage for a new checkout: forced by config, or the probe's answer (cached). */
  private async storageFor(): Promise<CheckoutStorage> {
    if (this.config.remote !== undefined) return 'volume'
    if (this.config.storage === 'bind' || this.config.storage === 'volume') return this.config.storage
    this.storageChoice ??= this.probeStorage()
    const choice = await this.storageChoice
    if (choice === undefined) {
      this.storageChoice = undefined
      throw new WorkspaceError('unsafe-state', 'the sandbox user can write neither a host folder nor a Docker volume on this Docker host')
    }
    return choice
  }

  /**
   * Put a trusted bundle's base branch into an empty checkout volume and create the working branch, as the sandbox
   * user in a one-shot container. Git runs only inside the sandbox; the host only made the bundle.
   */
  private async importCheckout(volume: string, path: string, bundle: string, baseBranch: string, workingBranch: string, cloneUrl: string): Promise<void> {
    const script = [
      'set -e', 'cd "$1"', 'cat > .dsh-code-import.bundle', 'git init -q',
      'git fetch -q --no-tags ./.dsh-code-import.bundle "refs/heads/$2:refs/remotes/origin/$2"', 'rm -f .dsh-code-import.bundle',
      'git remote add origin "$4"', 'git checkout -q -b "$2" "refs/remotes/origin/$2"', '[ "$3" = "$2" ] || git checkout -q -b "$3"',
    ].join('\n')
    await this.docker.stream([...this.oneShot(volume, path, `${this.config.uid}:${this.config.gid}`, [], true), 'sh', '-c', script, 'import', path, baseBranch, workingBranch, cloneUrl], { input: bundle })
  }

  /**
   * Build the worker image from the bundled Dockerfile. Runs only on an
   * explicit user action from the setup panel.
   * @param signal - cancels the build.
   * @returns the build log tail.
   */
  async buildWorker(signal?: AbortSignal): Promise<string> {
    const dir = this.config.workerDir
    if (dir === undefined || !existsSync(join(dir, 'Dockerfile'))) throw new WorkspaceError('not-found', 'the worker Dockerfile is not bundled with this installation')
    if (!existsSync(join(dir, 'fs-helper.js'))) throw new WorkspaceError('not-found', 'the worker file helper is missing; rebuild the dsh-code package')
    const args = ['build', '-t', this.config.image, dir]
    const result = await this.docker.tryExec(args, signal)
    // BuildKit reports progress on stderr.
    const log = `${result.stdout}\n${result.stderr}`.trim().split('\n').slice(-20).join('\n')
    if (result.code !== 0) throw new WorkspaceError('provision-failed', `worker image build failed:\n${log}`)
    return log
  }

  /** Load records from disk and reconcile them against Docker state. */
  async reconcile(): Promise<{ orphansRemoved: string[]; offline: string[] }> {
    await mkdir(this.recordsDir, { recursive: true })
    // Everything local first: a Docker host that is down (a stopped VM, no network) must not keep records,
    // overrides, variables or grants from loading.
    await mkdir(join(this.config.dataDir, 'overrides'), { recursive: true, mode: 0o700 })
    for (const file of await readdir(join(this.config.dataDir, 'overrides'))) {
      if (!file.endsWith('.json')) continue
      try {
        this.overrides.set(file.slice(0, -5), JSON.parse(await readFile(join(this.config.dataDir, 'overrides', file), 'utf8')) as Record<string, boolean>)
      } catch {
        // A damaged overrides file is ignored; the session follows Settings.
      }
    }
    // Session variables are read by every exec, which is synchronous; load them before any command runs.
    await mkdir(join(this.config.dataDir, 'env'), { recursive: true, mode: 0o700 })
    for (const file of await readdir(join(this.config.dataDir, 'env'))) {
      if (!file.endsWith('.json')) continue
      try {
        this.sessionEnv.set(file.slice(0, -5), JSON.parse(await readFile(join(this.config.dataDir, 'env', file), 'utf8')) as Record<string, string>)
      } catch {
        // A damaged variables file is ignored; the session starts with the defaults only.
      }
    }
    // Hosts approved per session through request_network_access.
    await mkdir(join(this.config.dataDir, 'network'), { recursive: true, mode: 0o700 })
    for (const file of await readdir(join(this.config.dataDir, 'network'))) {
      if (!file.endsWith('.json')) continue
      try {
        const hosts = JSON.parse(await readFile(join(this.config.dataDir, 'network', file), 'utf8')) as unknown
        if (Array.isArray(hosts)) this.grants.set(file.slice(0, -5), hosts.filter((h): h is string => typeof h === 'string'))
      } catch {
        // A damaged grants file is ignored; the session follows the shared allowlist.
      }
    }
    for (const file of await readdir(this.recordsDir)) {
      if (!file.endsWith('.json')) continue
      const record = JSON.parse(await readFile(join(this.recordsDir, file), 'utf8')) as WorkspaceRecord
      if (record.status !== 'deleted') this.records.set(record.sessionId, record)
    }
    try {
      return await this.reconcileDocker()
    } catch (error) {
      // The Docker host is unreachable: its workspaces are offline and restart with their next message once it is back.
      for (const record of this.records.values()) {
        if (!this.onOtherBackend(record) && record.status === 'ready') await this.setStatus(record, 'offline')
      }
      throw error
    }
  }

  /** The Docker half of {@link reconcile}: proxy, orphans and container state on this manager's Docker host. */
  private async reconcileDocker(): Promise<{ orphansRemoved: string[]; offline: string[] }> {
    await this.ensurePinned()
    // A running proxy reloads this file, so a policy saved while Harness was down applies now.
    await this.updatePolicy(this.config.policy)
    // Bring an existing proxy up to the shipped code now, not at the next new workspace.
    if (await this.docker.inspect(this.proxyContainer) !== undefined) {
      await this.ensureNetwork().catch((error: unknown) => { console.warn(`dsh-code: egress proxy refresh failed: ${String(error)}`) })
    }
    const orphansRemoved: string[] = []
    for (const id of await this.docker.containersWithLabel(`${INSTALLATION_LABEL}=${this.installationId}`)) {
      if (id === this.proxyContainer) continue
      const info = await this.docker.inspect(id)
      const sessionId = info?.labels[SESSION_LABEL]
      if (sessionId === undefined || info?.labels[OWNER_LABEL] !== this.owner) continue
      if (!this.records.has(sessionId)) {
        await this.docker.removeContainer(id)
        orphansRemoved.push(id)
      }
    }
    const volumes = new Set([...this.records.values()].flatMap(r => r.volume === undefined ? [] : [r.volume]))
    for (const volume of await this.docker.volumesWithLabel(`${INSTALLATION_LABEL}=${this.installationId}`)) {
      if (volume.labels[OWNER_LABEL] === this.owner && volume.labels[VOLUME_KIND_LABEL] === 'checkout' && !volumes.has(volume.name)) {
        await this.docker.removeVolume(volume.name)
        orphansRemoved.push(volume.name)
      }
    }
    const offline: string[] = []
    for (const record of this.records.values()) {
      if (record.status === 'deleting') {
        await this.delete(record.sessionId).catch(() => undefined)
        continue
      }
      if (this.onOtherBackend(record)) {
        // It lives on the other Docker host (local vs remote); switching back brings it back.
        if (record.status !== 'offline') await this.setStatus(record, 'offline')
        continue
      }
      const info = await this.docker.inspect(record.containerName)
      if (info === undefined || !info.running || info.runtime !== REQUIRED_RUNTIME) {
        await this.setStatus(record, 'offline')
        offline.push(record.sessionId)
      } else {
        await this.learnAddress(record)
      }
    }
    await this.writePolicy()
    return { orphansRemoved, offline }
  }

  /** Ensure the internal network and the egress proxy are running with the current policy. */
  async ensureNetwork(): Promise<void> {
    await mkdir(join(this.config.dataDir, 'egress'), { recursive: true })
    await cp(this.config.proxyDir, this.proxySourceDir, { recursive: true, force: true })
    await this.writePolicy()
    await this.docker.ensureNetwork(this.internalNetwork, ['--internal', '--driver', 'bridge', '--label', `${OWNER_LABEL}=${this.owner}`])
    await this.docker.ensureNetwork(this.egressNetwork, ['--driver', 'bridge', '--label', `${OWNER_LABEL}=${this.owner}`])
    // A running proxy keeps the code it started with; recreate it when the shipped code changed (an upgrade).
    const version = await proxyCodeHash(this.proxySourceDir)
    const info = await this.docker.inspect(this.proxyContainer)
    if (info?.running === true && info.labels[PROXY_VERSION_LABEL] === version) return
    const before = info?.running === true ? await this.proxyAddress().catch(() => undefined) : undefined
    if (info !== undefined) await this.docker.removeContainer(this.proxyContainer)
    if (this.config.remote !== undefined) await this.uploadProxyCode()
    const codeMount = this.config.remote === undefined ? `type=bind,source=${this.proxySourceDir}` : `type=volume,source=${this.proxyCodeVolume}`
    const policyMount = this.config.remote === undefined ? `type=bind,source=${this.config.dataDir}/egress` : `type=volume,source=${this.policyVolume}`
    await this.docker.exec([
      // The proxy is dsh-code's own trusted code, not workspace code. It runs
      // under the default runtime because it must resolve names through the
      // daemon's resolver, which gVisor's network stack cannot reach.
      'create', '--name', this.proxyContainer,
      '--label', `${OWNER_LABEL}=${this.owner}`, '--label', `${PROXY_VERSION_LABEL}=${version}`,
      '--user', '65534:65534', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--read-only', '--pids-limit', '256', '--memory', '256m', '--restart', 'unless-stopped',
      '--network', this.egressNetwork,
      '--mount', `${codeMount},target=/opt/egress/src,readonly`,
      '--mount', `${policyMount},target=/opt/egress/policy,readonly`,
      this.config.proxyImage, 'node', `/opt/egress/src/${existsSync(join(this.proxySourceDir, 'entry.js')) ? 'entry.js' : 'entry.ts'}`, '/opt/egress/policy/policy.json', String(PROXY_PORT),
    ])
    await this.docker.exec(['network', 'connect', '--alias', this.proxyContainer, this.internalNetwork, this.proxyContainer])
    await this.docker.exec(['start', this.proxyContainer])
    // Workspaces have no DNS and reach the proxy at the address written into them at creation. If the new proxy got
    // another address, running workspaces cannot reach it: mark them offline so their next message restarts them.
    if (before !== undefined && before !== await this.proxyAddress().catch(() => undefined)) {
      for (const record of this.records.values()) if (record.status === 'ready') await this.setStatus(record, 'offline')
    }
  }

  private async proxyAddress(): Promise<string> {
    const address = await this.docker.exec(['inspect', '--format', `{{(index .NetworkSettings.Networks "${this.internalNetwork}").IPAddress}}`, this.proxyContainer])
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(address)) throw new WorkspaceError('provision-failed', 'egress proxy has no internal address')
    return address
  }

  /**
   * Replace the egress policy; the proxy reloads it and closes refused tunnels.
   * @param policy - the new policy.
   */
  async updatePolicy(policy: EgressPolicy): Promise<void> {
    this.config.policy = policy
    await this.writePolicy()
  }

  /** Hosts approved per session (request_network_access), persisted under dataDir/network. */
  private readonly grants = new Map<string, readonly string[]>()
  /** Internal-network address of each running workspace that has grants; the proxy keys grants by it. */
  private readonly addresses = new Map<string, string>()
  private grantsPath(sessionId: string): string { return join(this.config.dataDir, 'network', `${sessionId.replace(/[^A-Za-z0-9_-]/g, '_')}.json`) }

  /** @returns the shared policy plus each running session's approved hosts, keyed by its container address. */
  private composedPolicy(): EgressPolicy {
    const clients: Record<string, readonly string[]> = {}
    for (const [sessionId, address] of this.addresses) {
      const hosts = this.grants.get(sessionId)
      if (hosts !== undefined && hosts.length > 0) clients[address] = hosts
    }
    const { clients: _ignored, ...shared } = this.config.policy
    return Object.keys(clients).length === 0 ? shared : { ...shared, clients }
  }

  private async writePolicy(): Promise<void> {
    const text = JSON.stringify(this.composedPolicy())
    await mkdir(join(this.config.dataDir, 'egress'), { recursive: true })
    await writeFile(this.policyPath, text, { mode: 0o644 })
    if (this.config.remote !== undefined && text !== this.uploadedPolicy) {
      // The proxy on the VM reads its policy from a volume there; replace it atomically so a reload never sees half.
      await this.docker.ensureVolume(this.policyVolume, this.volumeLabels('proxy'))
      await this.docker.stream([...this.proxyHelper(this.policyVolume, '/p'), 'sh', '-c', 'cat > /p/.policy.json && chmod 644 /p/.policy.json && mv /p/.policy.json /p/policy.json'], { input: this.policyPath })
      this.uploadedPolicy = text
    }
  }

  /** The policy last written to the remote volume, so unchanged policies are not uploaded again. */
  private uploadedPolicy: string | undefined

  /** A one-shot container of the proxy image on one volume, for Code's own files on a remote Docker host. */
  private proxyHelper(volume: string, target: string): string[] {
    return ['run', '--rm', '-i', '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--label', `${OWNER_LABEL}=${this.owner}`,
      '--mount', `type=volume,source=${volume},target=${target}`, this.config.proxyImage]
  }

  /** Copy the proxy's code into its volume on the remote VM (a tar of the copy in dataDir). */
  private async uploadProxyCode(): Promise<void> {
    const archive = join(this.config.dataDir, 'egress', 'proxy-code.tar')
    await new Promise<void>((resolveTar, rejectTar) => {
      execFileCb('tar', ['-C', this.proxySourceDir, '-cf', archive, '.'], (error) => { if (error === null) resolveTar(); else rejectTar(error) })
    })
    try {
      await this.docker.ensureVolume(this.proxyCodeVolume, this.volumeLabels('proxy'))
      await this.docker.stream([...this.proxyHelper(this.proxyCodeVolume, '/code'), 'sh', '-c', 'find /code -mindepth 1 -delete && tar -xf - -C /code --no-same-owner && chmod -R a+rX /code'], { input: archive })
    } finally {
      await rm(archive, { force: true })
    }
  }

  /**
   * Record a running workspace's internal address; an address another session held before is taken from it.
   * @returns whether the composed policy changed.
   */
  private async learnAddress(record: WorkspaceRecord): Promise<boolean> {
    const before = JSON.stringify(this.composedPolicy())
    this.addresses.delete(record.sessionId)
    const result = await this.docker.tryExec(['inspect', '--format', `{{(index .NetworkSettings.Networks "${this.internalNetwork}").IPAddress}}`, record.containerName])
    const address = result.stdout.trim()
    if (result.code === 0 && /^\d+\.\d+\.\d+\.\d+$/.test(address)) {
      for (const [other, known] of this.addresses) if (known === address) this.addresses.delete(other)
      this.addresses.set(record.sessionId, address)
    }
    return JSON.stringify(this.composedPolicy()) !== before
  }

  /**
   * Hosts the user approved for one session.
   * @param sessionId - logical session id.
   * @returns host patterns, in approval order.
   */
  networkGrants(sessionId: string): readonly string[] {
    return this.grants.get(sessionId) ?? []
  }

  /**
   * Allow one more host for a session's workspace only; the proxy applies it within about a second.
   * @param sessionId - logical session id.
   * @param host - normalized host name or `*.suffix` pattern.
   */
  async grantNetwork(sessionId: string, host: string): Promise<void> {
    const hosts = [...new Set([...this.networkGrants(sessionId), host])]
    await mkdir(join(this.config.dataDir, 'network'), { recursive: true, mode: 0o700 })
    await writeFile(this.grantsPath(sessionId), JSON.stringify(hosts), { mode: 0o600 })
    this.grants.set(sessionId, hosts)
    const record = this.records.get(sessionId)
    if (record !== undefined && !this.addresses.has(sessionId)) await this.learnAddress(record)
    await this.writePolicy()
    await new Promise(resolve => setTimeout(resolve, POLICY_RELOAD_MS))
  }

  /**
   * Replace a session's approved hosts (the Environment tab removes them here).
   * @param sessionId - logical session id.
   * @param hosts - normalized host patterns.
   */
  async setNetworkGrants(sessionId: string, hosts: readonly string[]): Promise<void> {
    if (hosts.length === 0) {
      this.grants.delete(sessionId)
      await rm(this.grantsPath(sessionId), { force: true })
    } else {
      await mkdir(join(this.config.dataDir, 'network'), { recursive: true, mode: 0o700 })
      await writeFile(this.grantsPath(sessionId), JSON.stringify([...hosts]), { mode: 0o600 })
      this.grants.set(sessionId, [...hosts])
    }
    await this.writePolicy()
  }

  /**
   * Replace resource limits. Running containers get the new CPU, memory and
   * process limits in place when the runtime supports it; the `/tmp` size and
   * anything the runtime refuses take effect on the next restart.
   * @param limits - the new limits.
   * @returns session ids whose container kept its old limits until restart.
   */
  async updateLimits(limits: ResourceLimits): Promise<string[]> {
    this.config.limits = limits
    const deferred: string[] = []
    for (const record of this.records.values()) {
      if (record.status !== 'ready') continue
      const result = await this.docker.tryExec(['update', '--cpus', String(limits.cpus), '--memory', `${limits.memoryMb}m`, '--memory-swap', `${limits.memoryMb}m`, '--pids-limit', String(limits.pids), record.containerName])
      if (result.code !== 0) deferred.push(record.sessionId)
    }
    return deferred
  }

  /**
   * Resource usage of one workspace container.
   * @param sessionId - logical session id.
   * @returns usage, or undefined when the container is not running.
   */
  async usage(sessionId: string): Promise<WorkspaceUsage | undefined> {
    const record = this.records.get(sessionId)
    if (record === undefined || record.status !== 'ready') return undefined
    const stats = await this.docker.tryExec(['stats', '--no-stream', '--format', '{{json .}}', record.containerName])
    if (stats.code !== 0) return undefined
    const disk = await this.runInside(record, ['du', '-s', '-B1', record.path]).catch(() => '0')
    return parseStats(stats.stdout, this.config.limits, Number(disk.split(/\s+/)[0]) || 0)
  }

  /**
   * Internal address of a declared preview port, for the authenticated proxy.
   * @param sessionId - logical session id.
   * @param port - container port.
   * @returns host and port on the internal network.
   */
  /**
   * TCP ports a process in the workspace is listening on, read from /proc/net inside the container.
   * @param sessionId - logical session id.
   * @returns listening ports, each marked when it accepts only loopback connections.
   */
  async listeningPorts(sessionId: string): Promise<ListeningPort[]> {
    const record = this.require(sessionId)
    if (record.status !== 'ready') return []
    const text = await this.runInside(record, ['sh', '-c', 'cat /proc/net/tcp /proc/net/tcp6 2>/dev/null; true']).catch(() => '')
    return parseListeningPorts(text)
  }

  /**
   * `docker` arguments that open one connection to a port inside the workspace: a small Node relay connects to
   * 127.0.0.1 inside the container and carries the raw TCP bytes over the exec's stdin/stdout. Works on every host
   * (no route from the host into the container is needed) and reaches apps bound to 127.0.0.1 too.
   * @param sessionId - logical session id.
   * @param port - container port.
   * @returns argv after `docker`.
   */
  /**
   * `docker` arguments that run the isolated-browser bridge in the workspace, opening `url` first.
   * @param sessionId - logical session id.
   * @param url - start page, already checked by the caller.
   * @returns argv after `docker`.
   */
  async browserArgv(sessionId: string, url: string): Promise<string[]> {
    const record = this.require(sessionId)
    if (record.status !== 'ready') throw new WorkspaceError('unsafe-state', `workspace is ${record.status}`)
    return this.execArgv(record, ['node', '/opt/dsh-code/browser-bridge.js', url], record.path, {}, false)
  }

  async previewRelayArgv(sessionId: string, port: number): Promise<string[]> {
    // An empty list means no restriction: links are minted only for ports found listening (see previewUrl).
    if (this.config.previewPorts.length > 0 && !this.config.previewPorts.includes(port)) throw new WorkspaceError('unsafe-state', `port ${port} is not in Settings > Code > Preview ports`)
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new WorkspaceError('unsafe-state', `invalid port ${port}`)
    const record = this.require(sessionId)
    if (record.status !== 'ready') throw new WorkspaceError('unsafe-state', `workspace is ${record.status}`)
    return this.execArgv(record, ['node', '-e', PREVIEW_RELAY, String(port)], record.path, {}, false)
  }



  /** Load records from disk and reconcile them against Docker state. */

  /**
   * The record for a session, if any.
   * @param sessionId - logical session id.
   * @returns the record.
   */
  get(sessionId: string): WorkspaceRecord | undefined {
    return this.records.get(sessionId)
  }

  /** @returns every live record. */
  list(): WorkspaceRecord[] {
    return [...this.records.values()]
  }

  /**
   * Find the workspace whose checkout contains a path.
   * @param path - absolute host path.
   * @returns the owning record, or undefined.
   */
  owning(path: string): WorkspaceRecord | undefined {
    const target = resolve(path)
    for (const record of this.records.values()) {
      if (target === record.path || target.startsWith(`${record.path}/`)) return record
    }
    return undefined
  }

  /**
   * Provision a workspace for a session (idempotent per session).
   * @param sessionId - logical session id.
   * @param repository - repository to clone.
   * @param baseBranch - base branch.
   * @param onProgress - progress callback for the UI.
   * @returns the ready record.
   */
  provision(sessionId: string, repository: RepositoryRef, baseBranch: string, onProgress: (step: string, detail?: string) => void = () => {}, account: string = ''): Promise<WorkspaceRecord> {
    const existing = this.records.get(sessionId)
    if (existing !== undefined && this.onOtherBackend(existing)) {
      return Promise.reject(new WorkspaceError('unsafe-state', `[sandbox: the Code workspace is offline] this session's workspace lives on ${existing.backend === undefined || existing.backend === 'local' ? 'this computer' : 'the remote VM'}, and Code now uses ${this.config.remote === undefined ? 'this computer' : 'the remote VM'}. Switch Settings > Code > Remote Docker host back to reach it, or start a new session.`))
    }
    if (existing !== undefined && existing.status === 'ready') return Promise.resolve(existing)
    const inflight = this.pending.get(sessionId)
    if (inflight !== undefined) return inflight
    const attempt = this.doProvision(sessionId, repository, baseBranch, onProgress, account).finally(() => { this.pending.delete(sessionId) })
    this.pending.set(sessionId, attempt)
    return attempt
  }

  /**
   * The options a new container gets now: Lockdown forces a read-only checkout, no cache and no extra folders.
   * Folders that are unsafe, missing, not directories or inside dataDir are skipped and reported, never fatal.
   */
  private async optionsFor(repository: RepositoryRef, onProgress: (step: string, detail?: string) => void, sessionId: string, storage: CheckoutStorage = 'bind'): Promise<WorkspaceOptions> {
    const lockdown = this.config.lockdown === true
    const folders: string[] = []
    for (const folder of lockdown ? [] : this.config.readOnlyFolders ?? []) {
      if (this.config.remote !== undefined) {
        onProgress('folder-skipped', `${folder}: it is on this computer, and the sandbox runs on the remote VM`)
        continue
      }
      const dataDir = resolve(this.config.dataDir)
      const reason = unsafeFolderReason(folder)
        ?? (folder === dataDir || folder.startsWith(`${dataDir}/`) || dataDir.startsWith(`${folder}/`) ? 'it overlaps the Code data folder' : undefined)
        ?? (existsSync(folder) && statSync(folder).isDirectory() ? undefined : 'it does not exist or is not a folder')
      if (reason === undefined) folders.push(folder)
      else onProgress('folder-skipped', `${folder}: ${reason}`)
    }
    let cacheDir: string | undefined
    let cacheVolume: string | undefined
    if (!lockdown && this.config.dependencyCache === true && storage === 'volume') {
      // Same rule as the folder: one cache volume per repository.
      cacheVolume = `${this.namespace}-cache-${createHash('sha256').update(repository.fullName).digest('hex').slice(0, 16)}`
      await this.createOwnedVolume(cacheVolume, CACHE_TARGET, this.volumeLabels('cache'))
    } else if (!lockdown && this.config.dependencyCache === true) {
      // One cache per repository: a repository can never plant packages in another one's cache.
      cacheDir = join(this.config.dataDir, 'caches', repository.fullName.replace(/[^A-Za-z0-9._-]+/g, '__'))
      await mkdir(cacheDir, { recursive: true, mode: 0o700 })
      if (process.getuid?.() === 0) await chown(cacheDir, this.config.uid, this.config.gid)
    }
    return {
      readOnlyWorkspace: lockdown || this.config.readOnlyWorkspace === true || this.config.sessionReadOnly?.(sessionId) === true, readOnlyFolders: folders,
      shmMb: this.config.shmMb ?? 256, lockdown, ...cacheDir === undefined ? {} : { cacheDir }, ...cacheVolume === undefined ? {} : { cacheVolume },
    }
  }

  private readonly sessionEnv = new Map<string, Record<string, string>>()
  private readonly overrides = new Map<string, Record<string, boolean>>()
  private overridesPath(sessionId: string): string { return join(this.config.dataDir, 'overrides', `${sessionId.replace(/[^A-Za-z0-9_-]/g, '_')}.json`) }

  /**
   * A session's overrides of Settings > Code (absent fields follow Settings).
   * @param sessionId - logical session id.
   * @returns the saved overrides.
   */
  sessionOverrides(sessionId: string): Readonly<Record<string, boolean>> {
    return this.overrides.get(sessionId) ?? {}
  }

  /**
   * Replace a session's overrides; saved under dataDir/overrides.
   * @param sessionId - logical session id.
   * @param values - boolean overrides by name.
   */
  async setSessionOverrides(sessionId: string, values: Readonly<Record<string, boolean>>): Promise<void> {
    await mkdir(join(this.config.dataDir, 'overrides'), { recursive: true, mode: 0o700 })
    await writeFile(this.overridesPath(sessionId), JSON.stringify(values), { mode: 0o600 })
    this.overrides.set(sessionId, { ...values })
  }
  private envPath(sessionId: string): string { return join(this.config.dataDir, 'env', `${sessionId.replace(/[^A-Za-z0-9_-]/g, '_')}.json`) }

  /**
   * A session's own variables, saved under dataDir/env.
   * @param sessionId - logical session id.
   * @returns the session's variables (without the defaults).
   */
  async sessionEnvironment(sessionId: string): Promise<Record<string, string>> {
    const known = this.sessionEnv.get(sessionId)
    if (known !== undefined) return known
    let loaded: Record<string, string> = {}
    try {
      loaded = JSON.parse(await readFile(this.envPath(sessionId), 'utf8')) as Record<string, string>
    } catch {
      // No variables saved for this session.
    }
    this.sessionEnv.set(sessionId, loaded)
    return loaded
  }

  /**
   * Replace a session's own variables; the next command in its workspace sees them.
   * @param sessionId - logical session id.
   * @param env - already validated variables.
   */
  async setSessionEnvironment(sessionId: string, env: Readonly<Record<string, string>>): Promise<void> {
    await mkdir(join(this.config.dataDir, 'env'), { recursive: true, mode: 0o700 })
    await writeFile(this.envPath(sessionId), JSON.stringify(env), { mode: 0o600 })
    this.sessionEnv.set(sessionId, { ...env })
  }

  /**
   * Variables a command in this session starts with: the defaults, then the session's own values.
   * @param sessionId - logical session id.
   * @returns merged variables.
   */
  environmentFor(sessionId: string): Record<string, string> {
    return { ...this.config.environment, ...this.sessionEnv.get(sessionId) }
  }

  private async gitAs(account: string | undefined): Promise<Git> {
    return account === undefined || account === '' ? this.git : this.git.withEnv(await this.credentials(account))
  }

  private async doProvision(sessionId: string, repository: RepositoryRef, baseBranch: string, onProgress: (step: string, detail?: string) => void, account: string): Promise<WorkspaceRecord> {
    if (this.config.remoteError !== undefined) throw new WorkspaceError('unsafe-state', `the remote Docker host settings cannot be used: ${this.config.remoteError}`)
    const live = [...this.records.values()].filter(r => r.status !== 'deleted' && r.sessionId !== sessionId).length
    if (live >= this.config.maxWorkspaces) throw new WorkspaceError('limit-reached', `at most ${this.config.maxWorkspaces} Code workspaces may run on this host`)
    onProgress('checking-runtime')
    await this.ensurePinned()
    const runtimes = await this.docker.runtimes()
    if (!runtimes.includes(REQUIRED_RUNTIME)) throw new WorkspaceError('gvisor-unavailable', 'Docker has no runsc runtime; Code execution is blocked')
    onProgress('egress-proxy')
    await this.ensureNetwork()
    const workspaceId = this.records.get(sessionId)?.workspaceId ?? randomUUID()
    const path = join(this.config.dataDir, 'workspaces', workspaceId)
    const mirrorPath = join(this.config.dataDir, 'mirrors', `${workspaceId}.git`)
    const now = new Date().toISOString()
    const prior = this.records.get(sessionId)
    let record: WorkspaceRecord
    if (prior === undefined) {
      onProgress('resolving-revision')
      const workingBranch = this.config.newBranch === false ? baseBranch : workingBranchName()
      await mkdir(join(this.config.dataDir, 'workspaces'), { recursive: true })
      await mkdir(join(this.config.dataDir, 'mirrors'), { recursive: true })
      const storage = await this.storageFor()
      onProgress('cloning')
      const git = await this.gitAs(account)
      let baseCommit: string
      let volume: string | undefined
      if (storage === 'volume') {
        // The host clones into its own bare mirror, then hands the sandbox a bundle; the checkout exists only in
        // the volume, and the folder at `path` stays an empty placeholder for the Harness working directory.
        baseCommit = await git.cloneMirror(repository, baseBranch, mirrorPath)
        const bundle = `${mirrorPath}.in.bundle`
        try {
          await git.bundleBranch(mirrorPath, baseBranch, bundle)
          volume = `${this.namespace}-ws-${workspaceId}`
          onProgress('checkout-volume')
          await this.createOwnedVolume(volume, path, this.volumeLabels('checkout', workspaceId))
          await this.importCheckout(volume, path, bundle, baseBranch, workingBranch, repository.cloneUrl)
        } finally {
          await rm(bundle, { force: true })
        }
        await mkdir(path, { recursive: true })
      } else {
        const checkout = await git.prepareCheckout(repository, baseBranch, path, workingBranch)
        baseCommit = checkout.baseCommit
        await git.createMirror(repository, mirrorPath)
        await chownTree(path, this.config.uid, this.config.gid)
      }
      record = {
        storage, ...volume === undefined ? {} : { volume }, backend: this.backend,
        workspaceId, sessionId, repository, ...account === '' ? {} : { account }, baseBranch, baseCommit, workingBranch,
        path, mirrorPath, containerName: `${this.namespace}-${workspaceId.slice(0, 12)}`, image: this.config.image,
        runtime: REQUIRED_RUNTIME, status: 'provisioning', createdAt: now, updatedAt: now,
      }
      await this.save(record)
    } else {
      record = prior
      await this.setStatus(record, 'restarting')
    }
    try {
      onProgress('starting-container')
      // The old container's address may go to another workspace; its grants must not follow it.
      if (this.addresses.delete(sessionId)) await this.writePolicy()
      await this.docker.removeContainer(record.containerName)
      const proxyAddress = await this.proxyAddress()
      const options = await this.optionsFor(record.repository, onProgress, sessionId, record.storage)
      record.options = options
      await this.save(record)
      await this.docker.exec(createArgs({
        readOnlyWorkspace: options.readOnlyWorkspace, readOnlyFolders: options.readOnlyFolders, shmMb: options.shmMb,
        ...options.cacheDir === undefined ? {} : { cacheDir: options.cacheDir },
        ...options.cacheVolume === undefined ? {} : { cacheVolume: options.cacheVolume },
        ...record.storage === 'volume' ? { storage: 'volume' as const, volume: record.volume } : {},
        name: record.containerName, owner: this.owner, installation: this.installationId, image: record.image, sessionId, workspaceId,
        workspacePath: record.path, network: this.internalNetwork,
        proxyUrl: this.config.policy.mode === 'none' ? undefined : `http://${this.proxyContainer}:${PROXY_PORT}`,
        uid: this.config.uid, gid: this.config.gid, limits: this.config.limits,
        hosts: { [this.proxyContainer]: proxyAddress },
      }))
      await this.docker.exec(['start', record.containerName])
      onProgress('health-check')
      const info = await this.docker.inspect(record.containerName)
      if (info?.runtime !== REQUIRED_RUNTIME) throw new WorkspaceError('unsafe-state', 'container is not running under runsc')
      await this.docker.exec(['exec', record.containerName, 'true'])
      // Every workspace's address is tracked, so a new container that reuses a stopped one's address never inherits
      // its grants. When the policy file changed, wait for the proxy's one-second reload before the first command.
      if (await this.learnAddress(record)) {
        await this.writePolicy()
        await new Promise(resolve => setTimeout(resolve, POLICY_RELOAD_MS))
      }
      await this.setStatus(record, 'ready')
      return record
    } catch (error) {
      record.error = error instanceof Error ? error.message : String(error)
      await this.setStatus(record, 'failed')
      throw error instanceof WorkspaceError ? error : new WorkspaceError('provision-failed', record.error)
    }
  }

  /**
   * Restart the worker container while keeping the checkout.
   * @param sessionId - logical session id.
   * @returns the ready record.
   */
  restart(sessionId: string, onProgress?: (step: string) => void): Promise<WorkspaceRecord> {
    const record = this.records.get(sessionId)
    if (record === undefined) return Promise.reject(new WorkspaceError('not-found', `no workspace for session ${sessionId}`))
    return this.provision(sessionId, record.repository, record.baseBranch, onProgress, record.account)
  }

  /**
   * Build `docker exec` argv for a process inside the session container.
   * @param record - workspace.
   * @param argv - program.
   * @param cwd - absolute path inside the checkout.
   * @param env - environment.
   * @param tty - allocate a terminal.
   * @returns argv after `docker`.
   */
  execArgv(record: WorkspaceRecord, argv: readonly string[], cwd: string, env: Readonly<Record<string, string>>, tty: boolean): string[] {
    // A sandbox problem is reported as one, never as the command's own failure.
    if (record.status === 'offline') throw new WorkspaceError('unsafe-state', '[sandbox: the Code workspace is offline] its container stopped; it restarts with the next message (or use Restart in the Environment tab)')
    if (record.status !== 'ready') throw new WorkspaceError('unsafe-state', `[sandbox: the Code workspace is ${record.status}] wait until it is ready`)
    const target = resolve(cwd)
    if (target !== record.path && !target.startsWith(`${record.path}/`)) throw new WorkspaceError('unsafe-state', `[sandbox: access denied outside the Code workspace] cwd ${cwd} is outside the session checkout`)
    return execArgs(record.containerName, argv, target, env, tty)
  }

  /**
   * Run a command inside the container and capture output (for Git status/diff).
   * @param record - workspace.
   * @param argv - program.
   * @returns stdout.
   */
  async runInside(record: WorkspaceRecord, argv: readonly string[]): Promise<string> {
    return this.docker.exec(this.execArgv(record, argv, record.path, {}, false))
  }

  /**
   * Uncommitted and unpushed work, computed inside the sandbox.
   * @param sessionId - logical session id.
   * @returns counts, or undefined when the container is unavailable.
   */
  async pendingWork(sessionId: string): Promise<{ dirtyFiles: number; unpushedCommits: number } | undefined> {
    const record = this.records.get(sessionId)
    if (record === undefined || record.status !== 'ready') return undefined
    const status = await this.runInside(record, ['git', 'status', '--porcelain=v1'])
    const ahead = await this.runInside(record, ['git', 'rev-list', '--count', 'HEAD', '--not', '--remotes']).catch(() => '0')
    return { dirtyFiles: status === '' ? 0 : status.split('\n').length, unpushedCommits: Number(ahead) || 0 }
  }

  /**
   * Diff of the checkout against the pinned base, computed inside the sandbox.
   * @param sessionId - logical session id.
   * @returns unified diff.
   */
  async diff(sessionId: string): Promise<string> {
    const record = this.require(sessionId)
    await this.runInside(record, ['git', 'add', '--intent-to-add', '--all'])
    return this.runInside(record, ['git', 'diff', record.baseCommit, '--'])
  }

  /**
   * Commit all changes inside the sandbox and push the working branch from the host mirror.
   * @param sessionId - logical session id.
   * @param message - commit message.
   * @returns the pushed SHA.
   */
  async commitAndPush(sessionId: string, message: string): Promise<{ sha: string; branch: string }> {
    const record = this.require(sessionId)
    await this.runInside(record, ['git', 'add', '--all'])
    const staged = await this.runInside(record, ['git', 'diff', '--cached', '--name-only'])
    if (staged !== '') {
      await this.runInside(record, ['git', '-c', 'user.name=DeepSeek Harness Code', '-c', 'user.email=dsh-code@users.noreply.github.com', 'commit', '-q', '-m', message])
    }
    // The bundle streams out of the sandbox on stdout into a host-only file: the host never opens a path in the
    // sandbox-writable checkout, and `bundle verify` checks it before the mirror fetches from it.
    const copy = `${record.mirrorPath}.bundle`
    await this.docker.stream(this.execArgv(record, ['git', 'bundle', 'create', '-q', '-', `refs/heads/${record.workingBranch}`], record.path, {}, false), { output: copy, maxBytes: MAX_BUNDLE_BYTES })
    try {
      const sha = await (await this.gitAs(record.account)).pushFromBundle(record.mirrorPath, copy, record.workingBranch)
      return { sha, branch: record.workingBranch }
    } finally {
      await rm(copy, { force: true })
    }
  }

  /**
   * Delete the container, the checkout, the mirror and the record. Remote
   * branches and pull requests are left untouched.
   * @param sessionId - logical session id.
   */
  async delete(sessionId: string): Promise<void> {
    this.sessionEnv.delete(sessionId)
    await rm(this.envPath(sessionId), { force: true })
    this.overrides.delete(sessionId)
    await rm(this.overridesPath(sessionId), { force: true })
    this.grants.delete(sessionId)
    await rm(this.grantsPath(sessionId), { force: true })
    if (this.addresses.delete(sessionId)) await this.writePolicy()
    const record = this.records.get(sessionId)
    if (record === undefined) return
    await this.setStatus(record, 'deleting')
    // On the other Docker host, its container and volume are orphans once the record is gone: the next start on
    // that host removes them.
    if (!this.onOtherBackend(record)) {
      await this.docker.removeContainer(record.containerName)
      if (record.volume !== undefined) await this.docker.removeVolume(record.volume)
    }
    await rm(record.path, { recursive: true, force: true })
    await rm(record.mirrorPath, { recursive: true, force: true })
    await this.setStatus(record, 'deleted')
    this.records.delete(sessionId)
    await rm(join(this.recordsDir, `${record.workspaceId}.json`), { force: true })
  }

  private require(sessionId: string): WorkspaceRecord {
    const record = this.records.get(sessionId)
    if (record === undefined) throw new WorkspaceError('not-found', `no workspace for session ${sessionId}`)
    return record
  }

  /**
   * Mark ready workspaces whose container stopped (VM restart, out of memory, Docker restarted) as offline, so
   * commands report a sandbox problem and the next message restarts the workspace.
   * @returns session ids that went offline.
   */
  async checkHealth(): Promise<string[]> {
    const offline: string[] = []
    for (const record of this.records.values()) {
      if (record.status !== 'ready' || this.onOtherBackend(record)) continue
      const info = await this.docker.inspect(record.containerName).catch(() => 'unknown' as const)
      if (info === 'unknown') continue
      if (info === undefined || !info.running) {
        await this.setStatus(record, 'offline')
        offline.push(record.sessionId)
        if (this.addresses.delete(record.sessionId)) await this.writePolicy()
      }
    }
    return offline
  }

  private async setStatus(record: WorkspaceRecord, status: WorkspaceStatus): Promise<void> {
    record.status = status
    record.updatedAt = new Date().toISOString()
    await this.save(record)
  }

  private async save(record: WorkspaceRecord): Promise<void> {
    this.records.set(record.sessionId, record)
    await mkdir(this.recordsDir, { recursive: true })
    await writeFile(join(this.recordsDir, `${record.workspaceId}.json`), JSON.stringify(record, null, 2))
  }
}

/** Path of the file helper in the worker image. */
const FS_HELPER = '/opt/dsh-code/fs-helper.js'

/** User-facing fixes for failing setup checks. */
export const SETUP_REMEDIES = {
  docker: 'Install Docker Engine (https://docs.docker.com/engine/install/) and start it, then make sure the user running Harness may use it.',
  runtime: 'Install gVisor (https://gvisor.dev/docs/user_guide/install/), register it with `sudo runsc install`, then `sudo systemctl reload docker`. Code never falls back to ordinary Docker.',
  image: (image: string): string => `Build the worker image: \`docker build -t ${image} <package>/worker\` after \`pnpm run build\`, or use Build worker image.`,
  remote: 'Check Settings > Code > Remote Docker host: the address and SSH port, the login, the private key file on this computer, and the host key fingerprint of the VM (docs/remote.md shows how to read it on Azure and AWS). The VM must accept SSH from this computer.',
  tailnet: 'This computer is not on Tailscale: install Tailscale here and log in to the same tailnet as the VM, or switch Network path back to Public SSH.',
  privateHost: 'Use the VM\'s Tailscale (100.x.y.z) or WireGuard address as the host, or switch Network path back to Public SSH.',
  closePublic: 'Close public SSH in the VM\'s firewall: Settings > Code > Remote Docker host > Restrict SSH shows the commands for Azure and AWS. Keep a way back in first (the cloud console\'s serial console, Azure Bastion or AWS Session Manager): if Tailscale or WireGuard stops, public SSH was the way in.',
  remotePrepare: 'Use Prepare the VM: Code logs in over SSH and installs Docker and gVisor with sudo (Ubuntu, Debian, Amazon Linux, Fedora), then adds the login to the docker group. Or install them by hand as docs/remote.md describes.',
  storage: 'Set Checkout storage to Automatic in Settings > Code: new checkouts then live in Docker volumes, which the sandbox user can write.',
  dataDir: 'Choose a data folder the container user can traverse, outside a private home directory (Settings > Code needs a restart for this one, or set dataDir in cordis.patch.yml).',
} as const

const UNITS: Record<string, number> = { b: 1, kb: 1e3, mb: 1e6, gb: 1e9, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4 }

/**
 * Parse a Docker size such as `12.5MiB`.
 * @param text - size text.
 * @returns bytes.
 */
export function parseSize(text: string): number {
  const match = /^\s*([\d.]+)\s*([a-zA-Z]*)\s*$/.exec(text)
  if (match === null) return 0
  return Math.round(Number(match[1]) * (UNITS[(match[2] ?? 'b').toLowerCase() || 'b'] ?? 1))
}

/**
 * Parse one `docker stats --format '{{json .}}'` line.
 * @param line - JSON line.
 * @param limits - configured limits, for the process limit.
 * @param diskBytes - checkout size.
 * @returns usage.
 */
export function parseStats(line: string, limits: ResourceLimits, diskBytes: number): WorkspaceUsage {
  const raw = JSON.parse(line.trim().split('\n')[0] ?? '{}') as { CPUPerc?: string; MemUsage?: string; PIDs?: string }
  const [used, limit] = (raw.MemUsage ?? '0B / 0B').split('/')
  return {
    cpuPercent: Number.parseFloat(raw.CPUPerc ?? '0') || 0,
    memoryBytes: parseSize(used ?? '0'),
    memoryLimitBytes: parseSize(limit ?? '0') || limits.memoryMb * 1024 * 1024,
    pids: Number.parseInt(raw.PIDs ?? '0', 10) || 0,
    pidsLimit: limits.pids,
    diskBytes,
  }
}

/**
 * Read this data folder's installation id, creating it on first use.
 * @param dataDir - the Code data folder.
 * @returns a random UUID kept in dataDir/installation-id.
 */
export function installationIdOf(dataDir: string): string {
  const file = join(dataDir, 'installation-id')
  try {
    const known = readFileSync(file, 'utf8').trim()
    if (/^[0-9a-f-]{36}$/.test(known)) return known
  } catch {
    // First use of this data folder.
  }
  const id = randomUUID()
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(file, `${id}\n`, { mode: 0o600 })
  return id
}

/** Largest push bundle accepted from a workspace. */
export const MAX_BUNDLE_BYTES = 2 * 1024 ** 3

/**
 * Give a fresh checkout to the sandbox user when Harness runs as root; a no-op otherwise.
 * Exported for the root-only regression test.
 * @param path - checkout root.
 * @param uid - sandbox uid.
 * @param gid - sandbox gid.
 */
export async function chownTree(path: string, uid: number, gid: number): Promise<void> {
  if (process.getuid?.() !== 0) return
  await chown(path, uid, gid)
  for (const entry of await readdir(path, { withFileTypes: true, recursive: true })) {
    // A cloned repository can contain symlinks to host files; chown would follow them and hand
    // those files to the sandbox user. lchown changes the link itself.
    const target = join(entry.parentPath, entry.name)
    await (entry.isSymbolicLink() ? lchown(target, uid, gid) : chown(target, uid, gid)).catch(() => undefined)
  }
}
