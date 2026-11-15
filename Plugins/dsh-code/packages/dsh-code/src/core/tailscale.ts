/**
 * Join the remote VM to the user's tailnet, on the user's request from Settings > Code. Over the existing SSH
 * connection, Code installs Tailscale with its official script when missing and runs `sudo tailscale up`; the login
 * link Tailscale prints is shown to the user, who approves the VM in their own browser. Code never sees or passes an
 * auth key, and keeps Tailscale SSH off (`--ssh=false`): Tailscale SSH would take port 22 on the tailnet address and
 * bypass the pinned host key and the key login.
 *
 * The login link lets whoever opens it add the VM to their tailnet, so it is shown only in Settings and never logged.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { isIP } from 'node:net'
import { isTailscaleAddress } from './network-path.ts'

/** Runs on the VM through `sh -s`. */
export const TAILSCALE_JOIN_SCRIPT = `set -eu
if ! command -v tailscale >/dev/null 2>&1; then
  echo "dsh-code: installing Tailscale"
  curl -fsSL https://tailscale.com/install.sh | sh
fi
echo "dsh-code: starting Tailscale"
sudo tailscale up --ssh=false
echo "dsh-code: tailscale-ip $(tailscale ip -4 | head -n 1)"
`

/** Where a join stands. */
export interface TailscaleJoinState {
  readonly state: 'idle' | 'installing' | 'waiting-for-login' | 'joined' | 'failed'
  /** The link to approve the VM; present while waiting for the user. */
  readonly loginUrl?: string
  /** The VM's tailnet IPv4 address once joined. */
  readonly address?: string
  readonly error?: string
}

/**
 * The login link in one line of `tailscale up` output.
 * @param line - output line.
 * @returns the https link on a tailscale.com host, or undefined.
 */
export function parseLoginUrl(line: string): string | undefined {
  const match = /https:\/\/login\.tailscale\.com\/a\/[A-Za-z0-9]+/.exec(line)
  return match?.[0]
}

/**
 * The VM's tailnet address from the script's last line.
 * @param line - output line.
 * @returns the address when it is a Tailscale IPv4 address.
 */
export function parseJoinedAddress(line: string): string | undefined {
  const match = /^dsh-code: tailscale-ip (\S+)\s*$/.exec(line)
  const address = match?.[1]
  return address !== undefined && isIP(address) === 4 && isTailscaleAddress(address) ? address : undefined
}

/** One join at a time per Code service; the process ends with the service or after the timeout. */
export class TailscaleJoin {
  private current: TailscaleJoinState = { state: 'idle' }
  private child: ChildProcess | undefined
  private timer: NodeJS.Timeout | undefined

  /**
   * @param command - argv that runs `sh -s` on the VM (Code's ssh wrapper).
   * @param timeoutMs - how long to wait for the user to approve.
   */
  constructor(private readonly command: () => readonly string[], private readonly timeoutMs = 15 * 60_000) {}

  /** @returns the current state. */
  status(): TailscaleJoinState { return this.current }

  /**
   * Start a join unless one is running.
   * @returns the state right after starting.
   */
  start(): TailscaleJoinState {
    if (this.child !== undefined) return this.current
    const [binary, ...args] = this.command()
    this.current = { state: 'installing' }
    const child = spawn(binary!, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    this.child = child
    let tail = ''
    const onLine = (line: string): void => {
      const url = parseLoginUrl(line)
      if (url !== undefined) this.current = { state: 'waiting-for-login', loginUrl: url }
      const address = parseJoinedAddress(line)
      if (address !== undefined) this.current = { state: 'joined', address }
      if (!/login\.tailscale\.com/.test(line)) tail = `${tail}\n${line}`.split('\n').slice(-6).join('\n')
    }
    for (const stream of [child.stdout, child.stderr]) {
      let buffer = ''
      stream?.setEncoding('utf8')
      stream?.on('data', (chunk: string) => {
        buffer += chunk
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) onLine(line)
      })
    }
    this.timer = setTimeout(() => { this.stop('the VM was not approved in time; start again to get a new link') }, this.timeoutMs)
    child.on('error', (error) => { if (this.child === child) this.finish(error.message) })
    child.on('close', (code) => {
      // A stopped or timed-out join already reported why.
      if (this.child !== child) return
      if (this.current.state === 'joined') this.finish()
      else this.finish(code === 0 ? 'Tailscale started but reported no address' : `joining failed:${tail === '' ? ` exit ${code ?? 'signal'}` : tail}`)
    })
    child.stdin?.end(TAILSCALE_JOIN_SCRIPT)
    return this.current
  }

  /**
   * Stop a running join.
   * @param reason - shown as the failure.
   */
  stop(reason = 'stopped'): void {
    this.child?.kill()
    this.finish(reason)
  }

  private finish(error?: string): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    this.child = undefined
    if (error !== undefined && this.current.state !== 'joined') this.current = { state: 'failed', error }
  }
}
