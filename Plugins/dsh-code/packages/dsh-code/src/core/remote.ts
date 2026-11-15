/**
 * Remote Docker host: Code runs its sandboxes on a Linux VM the user owns (an Azure VM, an AWS EC2 instance, any
 * SSH-reachable machine) instead of this computer. Harness, the model, the GitHub token and the host-side Git mirror
 * stay here; the VM only runs Docker with gVisor.
 *
 * Every Docker call goes through a generated `docker` wrapper that sets `DOCKER_HOST=ssh://dsh-code-remote` and puts
 * a generated `ssh` first on PATH. That `ssh` reads only Code's own config file, so the user's `~/.ssh/config` and
 * known hosts are neither read nor changed. The config pins the VM's host key (the user gives its SHA256
 * fingerprint; a server offering any other key is refused), uses one key file, never prompts, and reuses one
 * connection for all calls.
 */
import { execFile, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isIP } from 'node:net'

/** Where and how to reach the VM. */
export interface RemoteHost {
  /** DNS name or IP address. */
  readonly host: string
  readonly port: number
  /** Login with Docker access on the VM (its `docker` group); `sudo` is needed only to prepare it. */
  readonly user: string
  /** Private key file on this computer; it is referenced, never copied. */
  readonly identityFile: string
  /** The VM's host key fingerprint as `ssh-keygen -l` prints it, `SHA256:…`. */
  readonly hostKey: string
  /** How SSH reaches the VM; direct when absent. */
  readonly via?: RemoteVia
}

/**
 * The path SSH takes to the VM. `direct`: its address (public, Tailscale or WireGuard). `aws-ssm`: AWS Systems
 * Manager Session Manager, no inbound port at all. `azure-bastion`: an Azure Bastion tunnel, no public IP needed.
 * Both use the user's own cloud CLI and its credentials on this computer; Code never reads or stores them.
 */
export type RemoteVia =
  | { readonly kind: 'direct' }
  | { readonly kind: 'aws-ssm'; readonly instanceId: string; readonly region: string; readonly profile?: string }
  | { readonly kind: 'azure-bastion'; readonly bastion: string; readonly resourceGroup: string; readonly vmId: string; readonly subscription?: string }

/** Absolute paths of the tools a connection needs. */
export interface RemoteTools {
  readonly ssh: string
  readonly docker: string
  /** The AWS CLI, for Session Manager. */
  readonly aws?: string
  /** The Azure CLI, for Bastion. */
  readonly az?: string
  /** Node, which runs Code's Bastion tunnel helper. */
  readonly node?: string
}

/**
 * Check the connection path at the input boundary; the values end up in a ProxyCommand line.
 * @param via - candidate path.
 * @returns the same path, trimmed.
 */
export function validateVia(via: RemoteVia): RemoteVia {
  if (via.kind === 'direct') return via
  if (via.kind === 'aws-ssm') {
    const instanceId = via.instanceId.trim()
    const region = via.region.trim()
    const profile = via.profile?.trim() ?? ''
    if (!/^(i|mi)-[0-9a-f]{8,17}$/.test(instanceId)) throw new RemoteError('host', 'the instance ID must look like i-0123456789abcdef0')
    if (!/^[a-z]{2}(-gov)?-[a-z]+-\d$/.test(region)) throw new RemoteError('host', 'the AWS region must look like eu-west-1')
    if (profile !== '' && !/^[A-Za-z0-9_.-]{1,64}$/.test(profile)) throw new RemoteError('host', 'the AWS profile must be a profile name')
    return { kind: 'aws-ssm', instanceId, region, ...profile === '' ? {} : { profile } }
  }
  const bastion = via.bastion.trim()
  const resourceGroup = via.resourceGroup.trim()
  const vmId = via.vmId.trim()
  const subscription = via.subscription?.trim() ?? ''
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(bastion)) throw new RemoteError('host', 'the Bastion name must be an Azure resource name')
  if (!/^[-\w.()]{1,90}$/.test(resourceGroup)) throw new RemoteError('host', 'the resource group must be an Azure resource group name')
  if (!/^\/subscriptions\/[0-9a-f-]{36}\/resourceGroups\/[-\w.()]{1,90}\/providers\/Microsoft\.Compute\/virtualMachines\/[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/i.test(vmId)) {
    throw new RemoteError('host', 'the VM resource ID must look like /subscriptions/<id>/resourceGroups/<group>/providers/Microsoft.Compute/virtualMachines/<name>')
  }
  if (subscription !== '' && !/^[0-9a-f-]{36}$/i.test(subscription)) throw new RemoteError('host', 'the subscription must be a subscription ID')
  return { kind: 'azure-bastion', bastion, resourceGroup, vmId, ...subscription === '' ? {} : { subscription } }
}

/**
 * The name a proxied VM goes by in Code's SSH config and connection socket: its instance ID or VM name.
 * @param via - a validated path.
 * @returns a host-name-like label, or undefined for direct.
 */
export function viaLabel(via: RemoteVia | undefined): string | undefined {
  if (via === undefined || via.kind === 'direct') return undefined
  return via.kind === 'aws-ssm' ? via.instanceId : via.vmId.split('/').pop()!
}

/** The local port of one Azure Bastion tunnel, from the connection id (40000–49999). */
export function bastionPort(remote: Pick<RemoteHost, 'user' | 'host' | 'port'>): number {
  return 40000 + (Number.parseInt(connectionId(remote), 16) % 10000)
}

/**
 * Short id of one SSH destination, for its connection socket.
 * @param remote - settings.
 * @returns 8 hex characters of a hash of login, host and port.
 */
export function connectionId(remote: Pick<RemoteHost, 'user' | 'host' | 'port'>): string {
  return createHash('sha256').update(`${remote.user}@${remote.host}:${remote.port}`).digest('hex').slice(0, 8)
}

/** Unix socket paths are limited to 104 bytes on macOS, and ssh adds a 17-character suffix while creating one. */
const SOCKET_PATH_MAX = 104 - 18

/**
 * Where the shared connection's socket lives: in Code's remote folder, or, when that path is too long for a Unix
 * socket, in a private /tmp/dsh-code-<uid> folder that must be a real directory owned by this user with no access
 * for others.
 * @param dir - Code's remote folder.
 * @param remote - settings.
 * @returns the socket path.
 */
export function controlPath(dir: string, remote: Pick<RemoteHost, 'user' | 'host' | 'port'>): string {
  const name = `cm-${connectionId(remote)}`
  if (join(dir, name).length <= SOCKET_PATH_MAX) return join(dir, name)
  const uid = process.getuid?.() ?? 0
  const short = `/tmp/dsh-code-${uid}`
  mkdirSync(short, { recursive: true, mode: 0o700 })
  const info = lstatSync(short)
  if (!info.isDirectory() || info.uid !== uid || (info.mode & 0o077) !== 0) throw new RemoteError('connection', `${short} must be a directory owned by this user with no access for others`)
  return join(short, name)
}

/** Host alias in Code's SSH config. */
export const REMOTE_ALIAS = 'dsh-code-remote'

/** A remote setting that cannot work, with the field it concerns. */
export class RemoteError extends Error {
  /**
   * @param field - the setting at fault, or `connection`.
   * @param message - what is wrong and what to do.
   */
  constructor(readonly field: keyof RemoteHost | 'connection', message: string) {
    super(message)
    this.name = 'RemoteError'
  }
}

const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i

/**
 * Check remote settings at the input boundary. The values end up in an SSH config file and a shell script, so only
 * plain host names, logins, absolute paths and fingerprints pass.
 * @param remote - candidate settings.
 * @returns the same settings, trimmed.
 * @throws RemoteError for the first invalid field.
 */
export function validateRemote(remote: RemoteHost): RemoteHost {
  const host = remote.host.trim()
  if (!HOSTNAME.test(host) && isIP(host) === 0) throw new RemoteError('host', 'must be a host name or an IP address')
  if (!Number.isInteger(remote.port) || remote.port < 1 || remote.port > 65535) throw new RemoteError('port', 'must be 1 to 65535')
  const user = remote.user.trim()
  if (!/^[a-z_][a-z0-9_.-]{0,31}$/i.test(user)) throw new RemoteError('user', 'must be a Linux login name')
  const identityFile = remote.identityFile.trim()
  if (!identityFile.startsWith('/') || /[\s"'\\]/.test(identityFile) || identityFile.split('/').includes('..')) throw new RemoteError('identityFile', 'must be an absolute path without spaces or quotes')
  const hostKey = remote.hostKey.trim()
  if (!/^SHA256:[A-Za-z0-9+/]{43}=?$/.test(hostKey)) throw new RemoteError('hostKey', 'must be a SHA256 fingerprint as ssh-keygen -l prints it, for example SHA256:abc…')
  const via = remote.via === undefined || remote.via.kind === 'direct' ? undefined : validateVia(remote.via)
  return { host, port: remote.port, user, identityFile, hostKey: hostKey.replace(/=$/, ''), ...via === undefined ? {} : { via } }
}

/**
 * The SSH config Code uses for the VM.
 * @param dir - Code's remote folder (dataDir/remote).
 * @param remote - validated settings.
 * @returns the file content.
 */
export function sshConfig(dir: string, remote: RemoteHost, tools: Partial<RemoteTools> = {}): string {
  const q = (path: string): string => `"${path}"`
  const via = remote.via
  const proxy = via === undefined || via.kind === 'direct'
    ? []
    : via.kind === 'aws-ssm'
      ? [`  ProxyCommand '${tools.aws ?? 'aws'}' ssm start-session --target ${via.instanceId} --document-name AWS-StartSSHSession --parameters portNumber=%p --region ${via.region}${via.profile === undefined ? '' : ` --profile ${via.profile}`}`]
      : [`  ProxyCommand '${tools.node ?? 'node'}' '${join(dir, 'bastion-proxy.mjs')}'`]
  return [
    `Host ${REMOTE_ALIAS}`,
    `  HostName ${remote.host}`,
    `  Port ${remote.port}`,
    ...proxy,
    // Through a proxy the address is not the VM's own, so known_hosts names the VM by Code's alias.
    ...proxy.length === 0 ? [] : [`  HostKeyAlias ${REMOTE_ALIAS}`],
    `  User ${remote.user}`,
    `  IdentityFile ${q(remote.identityFile)}`,
    '  IdentitiesOnly yes',
    `  UserKnownHostsFile ${q(join(dir, 'known_hosts'))}`,
    '  GlobalKnownHostsFile /dev/null',
    '  StrictHostKeyChecking yes',
    '  CheckHostIP no',
    '  UpdateHostKeys no',
    '  BatchMode yes',
    '  PasswordAuthentication no',
    '  KbdInteractiveAuthentication no',
    '  ForwardAgent no',
    '  ForwardX11 no',
    '  ClearAllForwardings yes',
    '  ControlMaster auto',
    // One shared connection per host: the name changes with the host, so a connection to a VM chosen earlier is never
    // reused for a new one.
    `  ControlPath ${q(controlPath(dir, remote))}`,
    '  ControlPersist 600',
    '  ServerAliveInterval 30',
    '  ServerAliveCountMax 4',
    '',
  ].join('\n')
}

/**
 * Write the SSH config and the `ssh` and `docker` wrappers. Synchronous so the manager can use the wrapper from its
 * first call; the host key is pinned separately ({@link pinHostKey}) and, until it is, SSH refuses the VM.
 * @param dir - Code's remote folder (dataDir/remote).
 * @param remote - validated settings.
 * @param tools - absolute paths of the real `ssh` and `docker`.
 * @returns the `docker` wrapper to run instead of `docker`.
 */
export function writeRemoteFiles(dir: string, remote: RemoteHost, tools: RemoteTools): string {
  if ([dir, tools.ssh, tools.docker, tools.aws ?? '', tools.az ?? '', tools.node ?? ''].some(path => /["'\\\n$`]/.test(path))) throw new RemoteError('connection', `the Code data folder and the ssh and docker paths must not contain quotes, backslashes, $ or backticks: ${dir}`)
  // A connection still open to the host configured before must not carry the next commands.
  if (existsSync(join(dir, 'ssh_config'))) spawnSync(tools.ssh, ['-F', join(dir, 'ssh_config'), '-O', 'exit', REMOTE_ALIAS], { timeout: 5000, stdio: 'ignore' })
  mkdirSync(join(dir, 'bin'), { recursive: true, mode: 0o700 })
  writeFileSync(join(dir, 'ssh_config'), sshConfig(dir, remote, tools), { mode: 0o600 })
  if (remote.via?.kind === 'azure-bastion') {
    const via = remote.via
    writeFileSync(join(dir, 'bastion.json'), JSON.stringify({ az: tools.az ?? 'az', name: via.bastion, resourceGroup: via.resourceGroup, vmId: via.vmId, subscription: via.subscription, resourcePort: remote.port, port: bastionPort(remote) }), { mode: 0o600 })
    writeFileSync(join(dir, 'bastion-proxy.mjs'), BASTION_PROXY, { mode: 0o600 })
  }
  // Start with no trusted key: until pinHostKey checks the fingerprint the user gave, SSH refuses the VM.
  writeFileSync(join(dir, 'known_hosts'), '', { mode: 0o600 })
  const ssh = join(dir, 'bin', 'ssh')
  writeFileSync(ssh, `#!/bin/sh\nexec '${tools.ssh}' -F '${join(dir, 'ssh_config')}' "$@"\n`, { mode: 0o700 })
  chmodSync(ssh, 0o700)
  const docker = join(dir, 'docker')
  writeFileSync(docker, `#!/bin/sh\nPATH='${join(dir, 'bin')}':"$PATH"\nDOCKER_HOST=ssh://${REMOTE_ALIAS}\nDOCKER_CONTEXT=\nexport PATH DOCKER_HOST DOCKER_CONTEXT\nexec '${tools.docker}' "$@"\n`, { mode: 0o700 })
  chmodSync(docker, 0o700)
  return docker
}

function run(binary: string, args: readonly string[], input?: string, timeoutMs = 30_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile(binary, [...args], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ code: error === null ? 0 : typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1, stdout, stderr })
    })
    if (input !== undefined) child.stdin?.end(input)
  })
}

/**
 * Fingerprints of host key lines, as `ssh-keygen -l` prints them.
 * @param lines - known_hosts lines from ssh-keyscan.
 * @param sshKeygen - ssh-keygen binary.
 * @returns each line with its fingerprint and key type.
 */
export async function fingerprints(lines: readonly string[], sshKeygen = 'ssh-keygen'): Promise<{ line: string; fingerprint: string; type: string }[]> {
  const out: { line: string; fingerprint: string; type: string }[] = []
  for (const line of lines) {
    const result = await run(sshKeygen, ['-l', '-E', 'sha256', '-f', '-'], `${line}\n`)
    const match = /^\d+\s+(SHA256:[A-Za-z0-9+/]+)\s.*\((\w+)\)\s*$/m.exec(result.stdout)
    if (result.code === 0 && match !== null) out.push({ line, fingerprint: match[1]!, type: match[2]! })
  }
  return out
}

/**
 * Pin the VM's host key: ask the server for its keys and keep only the one whose fingerprint the user gave. A server
 * offering no such key (a different machine, or a man in the middle) is refused, and the error lists what it
 * offered so the user can compare it with the cloud console.
 * @param dir - Code's remote folder.
 * @param remote - validated settings.
 * @param tools - ssh-keyscan and ssh-keygen binaries.
 */
export function pinHostKey(dir: string, remote: RemoteHost, tools: { readonly sshKeyscan?: string; readonly sshKeygen?: string } = {}): Promise<void> {
  // Startup and a session's setup check can pin at the same time; they share one attempt, so a failing one never
  // clears a pin the other just wrote.
  const running = pinning.get(dir)
  if (running !== undefined) return running
  const attempt = pinOnce(dir, remote, tools).finally(() => { pinning.delete(dir) })
  pinning.set(dir, attempt)
  return attempt
}

/** The pin in progress for each remote folder. */
const pinning = new Map<string, Promise<void>>()

async function pinOnce(dir: string, remote: RemoteHost, tools: { readonly sshKeyscan?: string; readonly sshKeygen?: string }): Promise<void> {
  try {
    await pin(dir, remote, tools)
  } catch (error) {
    // A Bastion tunnel that is listening but dead (an expired az login) would otherwise be reused forever.
    if (remote.via?.kind === 'azure-bastion') stopBastionTunnel(dir)
    // A key pinned earlier must not outlive a failed check; the check's own error is what the user needs.
    try {
      writeFileSync(join(dir, 'known_hosts'), '', { mode: 0o600 })
    } catch {
      // No remote folder yet, so nothing was pinned either.
    }
    throw error
  }
}

async function pin(dir: string, remote: RemoteHost, tools: { readonly sshKeyscan?: string; readonly sshKeygen?: string }): Promise<void> {
  if (remote.via !== undefined && remote.via.kind !== 'direct') {
    await pinThroughProxy(dir, remote, tools.sshKeygen)
    return
  }
  const scan = await run(tools.sshKeyscan ?? 'ssh-keyscan', ['-T', '10', '-p', String(remote.port), remote.host], undefined, 20_000)
  const lines = scan.stdout.split('\n').map(l => l.trim()).filter(l => l !== '' && !l.startsWith('#'))
  if (lines.length === 0) throw new RemoteError('connection', `no SSH server answered at ${remote.host}:${remote.port}. Check the address, the port and that the VM's firewall (Azure network security group, AWS security group) allows SSH from this computer.`)
  const keys = await fingerprints(lines, tools.sshKeygen)
  const pinned = keys.filter(k => k.fingerprint === remote.hostKey)
  if (pinned.length === 0) {
    throw new RemoteError('hostKey', `the server at ${remote.host}:${remote.port} does not have the host key ${remote.hostKey}. It offered ${keys.map(k => `${k.fingerprint} (${k.type})`).join(', ')}. Compare with the VM's own fingerprint (see docs/remote.md) before using any of them.`)
  }
  writeFileSync(join(dir, 'known_hosts'), `${pinned.map(k => k.line).join('\n')}\n`, { mode: 0o600 })
}

/**
 * Pin the host key of a VM reached through Session Manager or Bastion, where ssh-keyscan cannot go: SSH itself
 * records the key the server presents before any login (authentication method `none`, so no key is offered), one
 * key type at a time, and only a key with the user's fingerprint is kept.
 */
async function pinThroughProxy(dir: string, remote: RemoteHost, sshKeygen?: string): Promise<void> {
  const offered: { line: string; fingerprint: string; type: string }[] = []
  for (const algorithm of ['ssh-ed25519', 'ecdsa-sha2-nistp256', 'rsa-sha2-512']) {
    const scratch = join(dir, `known_hosts.probe-${process.pid}-${Math.random().toString(36).slice(2)}`)
    writeFileSync(scratch, '', { mode: 0o600 })
    await run(join(dir, 'bin', 'ssh'), ['-T', '-o', `UserKnownHostsFile=${scratch}`, '-o', 'StrictHostKeyChecking=accept-new', '-o', `HostKeyAlgorithms=${algorithm}`,
      '-o', 'PreferredAuthentications=none', '-o', 'PubkeyAuthentication=no', '-o', 'ControlMaster=no', '-o', 'ControlPath=none', REMOTE_ALIAS, 'true'], undefined, 90_000)
    const lines = readFileSync(scratch, 'utf8').split('\n').map(l => l.trim()).filter(l => l !== '' && !l.startsWith('#'))
    rmSync(scratch, { force: true })
    offered.push(...await fingerprints(lines, sshKeygen))
    const match = offered.find(k => k.fingerprint === remote.hostKey)
    if (match !== undefined) {
      writeFileSync(join(dir, 'known_hosts'), `${match.line}\n`, { mode: 0o600 })
      return
    }
  }
  if (offered.length === 0) throw new RemoteError('connection', `the ${remote.via?.kind === 'aws-ssm' ? 'Session Manager' : 'Bastion'} connection to the VM did not open. Check the cloud CLI is installed and logged in on this computer and the settings (docs/remote.md).`)
  throw new RemoteError('hostKey', `the VM does not have the host key ${remote.hostKey}. It offered ${offered.map(k => `${k.fingerprint} (${k.type})`).join(', ')}. Compare with the VM's own fingerprint (see docs/remote.md) before using any of them.`)
}

/**
 * Code's ProxyCommand for Azure Bastion: opens `az network bastion tunnel` to the VM's SSH port on a local port when
 * none is listening, waits for it, then carries SSH over it. The tunnel outlives one SSH connection (Code's shared
 * connection uses one at a time) and is stopped with Code ({@link stopBastionTunnel}).
 */
export const BASTION_PROXY = `import { spawn } from 'node:child_process'
import { connect } from 'node:net'
import { openSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const dir = dirname(fileURLToPath(import.meta.url))
const c = JSON.parse(readFileSync(join(dir, 'bastion.json'), 'utf8'))
const open = () => new Promise((resolve) => {
  const socket = connect(c.port, '127.0.0.1')
  socket.once('connect', () => resolve(socket))
  socket.once('error', () => resolve(undefined))
})
let socket = await open()
if (socket === undefined) {
  const log = openSync(join(dir, 'bastion.log'), 'a')
  const args = ['network', 'bastion', 'tunnel', '--name', c.name, '--resource-group', c.resourceGroup, '--target-resource-id', c.vmId, '--resource-port', String(c.resourcePort), '--port', String(c.port)]
  if (c.subscription) args.push('--subscription', c.subscription)
  const child = spawn(c.az, args, { detached: true, stdio: ['ignore', log, log] })
  child.unref()
  writeFileSync(join(dir, 'bastion.pid'), String(child.pid))
  for (let i = 0; i < 120 && socket === undefined; i++) {
    await new Promise(r => setTimeout(r, 500))
    socket = await open()
  }
  if (socket === undefined) {
    process.stderr.write('dsh-code: the Azure Bastion tunnel did not open; see ' + join(dir, 'bastion.log') + '\\n')
    process.exit(1)
  }
}
process.stdin.pipe(socket)
socket.pipe(process.stdout)
socket.on('close', () => process.exit(0))
`

/**
 * Stop the Azure Bastion tunnel Code started, if any.
 * @param dir - Code's remote folder.
 */
export function stopBastionTunnel(dir: string): void {
  try {
    const pid = Number(readFileSync(join(dir, 'bastion.pid'), 'utf8').trim())
    if (Number.isInteger(pid) && pid > 1) process.kill(pid)
  } catch {
    // No tunnel was started, or it already ended.
  }
  rmSync(join(dir, 'bastion.pid'), { force: true })
}

/**
 * Run a command on the VM through Code's SSH config.
 * @param dir - Code's remote folder.
 * @param command - remote shell command.
 * @param input - optional stdin.
 * @param timeoutMs - how long to wait.
 * @returns exit code and output.
 */
export function remoteShell(dir: string, command: string, input?: string, timeoutMs = 30_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return run(join(dir, 'bin', 'ssh'), ['-T', REMOTE_ALIAS, command], input, timeoutMs)
}

/** Close the shared connection, so the next call logs in again (for example after joining the docker group). */
export async function closeConnection(dir: string): Promise<void> {
  await run(join(dir, 'bin', 'ssh'), ['-O', 'exit', REMOTE_ALIAS], undefined, 10_000)
}

/**
 * Prepares a fresh VM: Docker Engine and gVisor from the distribution's and gVisor's own package repositories
 * (Debian/Ubuntu: apt; Amazon Linux, Fedora, RHEL: dnf with gVisor's checksummed release), the `runsc` runtime
 * registered with Docker, and the login added to the `docker` group. Runs with `sudo` only when the user asks for it
 * from the setup notice; it changes nothing that is already in place.
 */
export const PREPARE_SCRIPT = `set -eu
log() { echo "dsh-code: $*"; }
if ! command -v docker >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then
    log "installing Docker (apt)"; sudo apt-get update -qq; sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq docker.io ca-certificates curl gnupg
  elif command -v dnf >/dev/null 2>&1; then
    log "installing Docker (dnf)"; sudo dnf install -y -q docker
  else
    log "no apt-get or dnf: install Docker Engine by hand"; exit 3
  fi
fi
sudo systemctl enable --now docker >/dev/null 2>&1 || true
if ! command -v runsc >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then
    log "installing gVisor (apt)"
    curl -fsSL https://gvisor.dev/archive.key | sudo gpg --batch --yes --dearmor -o /usr/share/keyrings/gvisor-archive-keyring.gpg
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/gvisor-archive-keyring.gpg] https://storage.googleapis.com/gvisor/releases release main" | sudo tee /etc/apt/sources.list.d/gvisor.list >/dev/null
    sudo apt-get update -qq; sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq runsc
  else
    log "installing gVisor (release tarball, sha512-checked)"
    tmp=$(mktemp -d); ARCH=$(uname -m); URL=https://storage.googleapis.com/gvisor/releases/release/latest/$ARCH
    if command -v zstd >/dev/null 2>&1; then F=gvisor.tar.zstd; X=--zstd; else F=gvisor.tar.bz2; X=-j; fi
    (cd "$tmp" && curl -fsSLO "$URL/$F" && curl -fsSLO "$URL/$F.sha512" && sha512sum -c "$F.sha512" && sudo tar "$X" -xf "$F" -C /usr/local/bin)
    rm -rf "$tmp"
  fi
fi
if ! sudo docker info --format '{{json .Runtimes}}' | grep -q '"runsc"'; then
  log "registering runsc with Docker"; sudo "$(command -v runsc)" install; sudo systemctl restart docker
fi
if ! id -nG "$(id -un)" | tr ' ' '\\n' | grep -qx docker; then
  log "adding $(id -un) to the docker group"; sudo usermod -aG docker "$(id -un)"
fi
log "ready: $(sudo docker info --format '{{.ServerVersion}}') with $(runsc --version 2>/dev/null | head -n 1)"
`
