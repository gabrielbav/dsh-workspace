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
import { chmodSync, existsSync, lstatSync, mkdirSync, writeFileSync } from 'node:fs'
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
  return { host, port: remote.port, user, identityFile, hostKey: hostKey.replace(/=$/, '') }
}

/**
 * The SSH config Code uses for the VM.
 * @param dir - Code's remote folder (dataDir/remote).
 * @param remote - validated settings.
 * @returns the file content.
 */
export function sshConfig(dir: string, remote: RemoteHost): string {
  const q = (path: string): string => `"${path}"`
  return [
    `Host ${REMOTE_ALIAS}`,
    `  HostName ${remote.host}`,
    `  Port ${remote.port}`,
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
export function writeRemoteFiles(dir: string, remote: RemoteHost, tools: { readonly ssh: string; readonly docker: string }): string {
  if (/["'\\\n$`]/.test(dir) || /["'\\\n$`]/.test(tools.ssh) || /["'\\\n$`]/.test(tools.docker)) throw new RemoteError('connection', `the Code data folder and the ssh and docker paths must not contain quotes, backslashes, $ or backticks: ${dir}`)
  // A connection still open to the host configured before must not carry the next commands.
  if (existsSync(join(dir, 'ssh_config'))) spawnSync(tools.ssh, ['-F', join(dir, 'ssh_config'), '-O', 'exit', REMOTE_ALIAS], { timeout: 5000, stdio: 'ignore' })
  mkdirSync(join(dir, 'bin'), { recursive: true, mode: 0o700 })
  writeFileSync(join(dir, 'ssh_config'), sshConfig(dir, remote), { mode: 0o600 })
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
export async function pinHostKey(dir: string, remote: RemoteHost, tools: { readonly sshKeyscan?: string; readonly sshKeygen?: string } = {}): Promise<void> {
  try {
    await pin(dir, remote, tools)
  } catch (error) {
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
