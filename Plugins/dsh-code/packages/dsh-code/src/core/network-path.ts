/**
 * How dsh reaches a remote Docker host, and how the user narrows who else can: the address the VM sees for this
 * dsh, firewall commands that allow only that address, and the checks for a private network (Tailscale or
 * WireGuard) where public SSH can be closed entirely.
 *
 * Addresses shown here appear only in Settings > Code, which only the Harness owner opens; they never reach the
 * model, the session log or Code's logs.
 */
import { connect } from 'node:net'
import { isIP } from 'node:net'
import { networkInterfaces } from 'node:os'

/** `public`: SSH to the VM's internet address. `private`: SSH over Tailscale or WireGuard, public SSH closed. */
export type RemoteNetwork = 'public' | 'private'

function ipv4(address: string): number | undefined {
  const parts = address.split('.')
  if (parts.length !== 4 || parts.some(p => !/^\d{1,3}$/.test(p) || Number(p) > 255)) return undefined
  return parts.reduce((n, p) => n * 256 + Number(p), 0)
}

function inV4(address: string, base: string, bits: number): boolean {
  const a = ipv4(address)
  const b = ipv4(base)
  if (a === undefined || b === undefined) return false
  const size = 2 ** (32 - bits)
  return Math.floor(a / size) === Math.floor(b / size)
}

/**
 * Whether an address is Tailscale's: 100.64.0.0/10 or fd7a:115c:a1e0::/48.
 * @param address - IP address.
 * @returns true for a tailnet address.
 */
export function isTailscaleAddress(address: string): boolean {
  if (isIP(address) === 4) return inV4(address, '100.64.0.0', 10)
  return isIP(address) === 6 && /^fd7a:115c:a1e0:/i.test(address)
}

/**
 * Whether an address can only be reached over a private network: Tailscale, RFC 1918, or IPv6 unique local.
 * @param address - IP address.
 * @returns true for a private address.
 */
export function isPrivateAddress(address: string): boolean {
  if (isTailscaleAddress(address)) return true
  if (isIP(address) === 4) return inV4(address, '10.0.0.0', 8) || inV4(address, '172.16.0.0', 12) || inV4(address, '192.168.0.0', 16)
  return isIP(address) === 6 && /^f[cd][0-9a-f]{2}:/i.test(address)
}

/**
 * The client address in `$SSH_CLIENT` (`<address> <port> <port>`), as the VM saw this dsh.
 * @param output - the variable's value.
 * @returns the address, or undefined when it is not one.
 */
export function parseSshClient(output: string): string | undefined {
  const address = output.trim().split(/\s+/)[0] ?? ''
  return isIP(address) === 0 ? undefined : address
}

/**
 * This computer's own Tailscale addresses, for wording a hint when the VM's tailnet address does not answer.
 * @param interfaces - network interfaces (tests).
 * @returns tailnet addresses of this computer.
 */
export function localTailscaleAddresses(interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces()): string[] {
  return Object.values(interfaces).flatMap(list => (list ?? []).map(i => i.address)).filter(isTailscaleAddress)
}

/**
 * Whether a TCP port answers from this computer. "Not reachable" means only that: a firewall may still let others in.
 * @param host - host name or address.
 * @param port - TCP port.
 * @param timeoutMs - how long to wait.
 * @returns true when a connection opened.
 */
export function probeTcp(host: string, port: number, timeoutMs = 4000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port })
    const done = (open: boolean): void => { socket.destroy(); resolve(open) }
    socket.setTimeout(timeoutMs, () => { done(false) })
    socket.once('connect', () => { done(true) })
    socket.once('error', () => { done(false) })
  })
}

/**
 * Ask a public echo service for this computer's internet address. Runs only when the user clicks Detect: it tells
 * that service this computer's address, which every server it connects to sees anyway.
 * @param url - the echo service (plain text answer).
 * @param timeoutMs - how long to wait.
 * @returns the address.
 */
export async function detectPublicAddress(url: string, timeoutMs = 5000): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'error' })
  if (!response.ok) throw new Error(`${url} answered ${response.status}`)
  const text = (await response.text()).trim()
  if (text.length > 64 || isIP(text) === 0) throw new Error(`${url} did not answer with an IP address`)
  return text
}

/** Copy-ready commands for one cloud. */
export interface FirewallCommands {
  readonly azure: readonly string[]
  readonly aws: readonly string[]
}

/**
 * Commands that let only one address reach the VM's SSH port. Names in angle brackets are the user's own
 * (docs/remote.md uses `dsh-code`, `dsh-code-vmNSG`, `ssh-from-me`). AWS rules only add access, so the commands
 * also remove the open-to-everyone rule.
 * @param address - the dsh address to allow.
 * @param port - SSH port.
 * @returns Azure and AWS commands.
 */
export function allowOnlyCommands(address: string, port = 22): FirewallCommands {
  const v6 = isIP(address) === 6
  const cidr = `${address}/${v6 ? 128 : 32}`
  return {
    azure: [
      `az network nsg rule list -g <resource-group> --nsg-name <nsg-name> -o table`,
      `az network nsg rule update -g <resource-group> --nsg-name <nsg-name> -n <ssh-rule> --source-address-prefixes ${cidr} --destination-port-ranges ${port}`,
    ],
    aws: [
      v6
        ? `aws ec2 authorize-security-group-ingress --group-id <security-group-id> --ip-permissions 'IpProtocol=tcp,FromPort=${port},ToPort=${port},Ipv6Ranges=[{CidrIpv6=${cidr}}]'`
        : `aws ec2 authorize-security-group-ingress --group-id <security-group-id> --protocol tcp --port ${port} --cidr ${cidr}`,
      `aws ec2 revoke-security-group-ingress --group-id <security-group-id> --protocol tcp --port ${port} --cidr 0.0.0.0/0`,
      `aws ec2 revoke-security-group-ingress --group-id <security-group-id> --ip-permissions 'IpProtocol=tcp,FromPort=${port},ToPort=${port},Ipv6Ranges=[{CidrIpv6=::/0}]'`,
    ],
  }
}

/**
 * Commands that close public SSH once the VM answers over the private network. Shown only after a login over the
 * private address has passed, so the user is never told to cut the only way in.
 * @param port - SSH port.
 * @returns Azure and AWS commands.
 */
export function closePublicCommands(port = 22): FirewallCommands {
  return {
    azure: [
      `az network nsg rule list -g <resource-group> --nsg-name <nsg-name> -o table`,
      `az network nsg rule delete -g <resource-group> --nsg-name <nsg-name> -n <ssh-rule>`,
    ],
    aws: [
      `aws ec2 describe-security-groups --group-ids <security-group-id> --query 'SecurityGroups[0].IpPermissions'`,
      `aws ec2 revoke-security-group-ingress --group-id <security-group-id> --protocol tcp --port ${port} --cidr <allowed-cidr>`,
    ],
  }
}
