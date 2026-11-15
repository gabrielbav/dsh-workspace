import { afterAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { createServer as createTcpServer } from 'node:net'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { allowOnlyCommands, closePublicCommands, detectPublicAddress, isPrivateAddress, isTailscaleAddress, localTailscaleAddresses, parseSshClient, probeTcp } from '../src/core/network-path.ts'
import { parseJoinedAddress, parseLoginUrl, TAILSCALE_JOIN_SCRIPT, TailscaleJoin } from '../src/core/tailscale.ts'

const root = mkdtempSync(join(tmpdir(), 'dsh-code-net-'))

/** Wait until a condition holds (process start-up is slower on a busy machine). */
async function until(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const end = Date.now() + timeoutMs
  while (!check() && Date.now() < end) await new Promise(r => setTimeout(r, 50))
}
const servers: Server[] = []
afterAll(() => { for (const s of servers) s.close(); rmSync(root, { recursive: true, force: true }) })

describe('network path helpers', () => {
  it('classifies Tailscale and private addresses', () => {
    for (const a of ['100.64.0.1', '100.101.102.103', '100.127.255.255', 'fd7a:115c:a1e0::1']) expect(isTailscaleAddress(a), a).toBe(true)
    for (const a of ['100.63.255.255', '100.128.0.1', '20.1.2.3', 'fd00::1']) expect(isTailscaleAddress(a), a).toBe(false)
    for (const a of ['10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '100.100.1.1', 'fd12:3456::1']) expect(isPrivateAddress(a), a).toBe(true)
    for (const a of ['172.32.0.1', '8.8.8.8', '20.1.2.3', '2001:db8::1']) expect(isPrivateAddress(a), a).toBe(false)
  })

  it('reads the client address from $SSH_CLIENT', () => {
    expect(parseSshClient('203.0.113.7 51234 22\n')).toBe('203.0.113.7')
    expect(parseSshClient('2001:db8::7 51234 22')).toBe('2001:db8::7')
    expect(parseSshClient('')).toBeUndefined()
    expect(parseSshClient('not-an-ip 1 2')).toBeUndefined()
  })

  it('finds this computer\'s tailnet addresses', () => {
    const lo = { address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', mac: '', internal: true, cidr: '127.0.0.1/8' } as const
    const ts = { ...lo, address: '100.101.1.2', internal: false, cidr: '100.101.1.2/32' }
    expect(localTailscaleAddresses({ lo0: [lo], utun4: [ts] })).toEqual(['100.101.1.2'])
    expect(localTailscaleAddresses({ lo0: [lo] })).toEqual([])
  })

  it('builds firewall commands that allow only one address and remove the open rules', () => {
    const v4 = allowOnlyCommands('203.0.113.7', 22)
    expect(v4.azure.join('\n')).toContain('--source-address-prefixes 203.0.113.7/32')
    expect(v4.aws.join('\n')).toContain('--cidr 203.0.113.7/32')
    expect(v4.aws.join('\n')).toContain('revoke-security-group-ingress --group-id <security-group-id> --protocol tcp --port 22 --cidr 0.0.0.0/0')
    expect(allowOnlyCommands('2001:db8::7').aws[0]).toContain('CidrIpv6=2001:db8::7/128')
    expect(closePublicCommands(2222).aws.join('\n')).toContain('--port 2222')
  })

  it('tells an open port from one that does not answer', async () => {
    const tcp = createTcpServer(socket => socket.end())
    await new Promise<void>(r => tcp.listen(0, '127.0.0.1', r))
    const port = (tcp.address() as AddressInfo).port
    expect(await probeTcp('127.0.0.1', port, 2000)).toBe(true)
    tcp.close()
    await new Promise(r => setTimeout(r, 50))
    expect(await probeTcp('127.0.0.1', port, 2000)).toBe(false)
  })

  it('detects an address from an echo service and refuses anything else', async () => {
    let answer = '198.51.100.9\n'
    const server = createServer((_req, res) => { res.end(answer) })
    servers.push(server)
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
    expect(await detectPublicAddress(url)).toBe('198.51.100.9')
    answer = '<html>not an address</html>'
    await expect(detectPublicAddress(url)).rejects.toThrow(/IP address/)
  })
})

describe('joining the VM to Tailscale', () => {
  it('never enables Tailscale SSH and never takes an auth key', () => {
    expect(TAILSCALE_JOIN_SCRIPT).toContain('tailscale up --ssh=false')
    expect(TAILSCALE_JOIN_SCRIPT).not.toMatch(/auth-?key/i)
  })

  it('reads the login link and the joined address, and nothing that only looks like them', () => {
    expect(parseLoginUrl('To authenticate, visit: https://login.tailscale.com/a/abc123XYZ')).toBe('https://login.tailscale.com/a/abc123XYZ')
    expect(parseLoginUrl('https://login.tailscale.com.evil.example/a/abc')).toBeUndefined()
    expect(parseJoinedAddress('dsh-code: tailscale-ip 100.101.1.2')).toBe('100.101.1.2')
    expect(parseJoinedAddress('dsh-code: tailscale-ip 203.0.113.7')).toBeUndefined()
  })

  it('reports the link while waiting, then the address, from a VM that prints what tailscale up prints', async () => {
    const fake = join(root, 'fake-vm.sh')
    writeFileSync(fake, '#!/bin/sh\ncat >/dev/null\necho "dsh-code: starting Tailscale"\necho "To authenticate, visit:" >&2\necho "  https://login.tailscale.com/a/1a2b3c4d" >&2\nsleep 1\necho "Success." >&2\necho "dsh-code: tailscale-ip 100.101.1.2"\n')
    chmodSync(fake, 0o700)
    const join_ = new TailscaleJoin(() => [fake])
    expect(join_.start().state).toBe('installing')
    await until(() => join_.status().state !== 'installing')
    expect(join_.status()).toMatchObject({ state: 'waiting-for-login', loginUrl: 'https://login.tailscale.com/a/1a2b3c4d' })
    await until(() => join_.status().state === 'joined')
    expect(join_.status()).toEqual({ state: 'joined', address: '100.101.1.2' })
  })

  it('fails with the VM\'s last lines, without the login link, and times out', async () => {
    const fake = join(root, 'fail-vm.sh')
    writeFileSync(fake, '#!/bin/sh\ncat >/dev/null\necho "https://login.tailscale.com/a/secret1" >&2\necho "sudo: a password is required" >&2\nexit 1\n')
    chmodSync(fake, 0o700)
    const failing = new TailscaleJoin(() => [fake])
    failing.start()
    await until(() => failing.status().state === 'failed')
    expect(failing.status().state).toBe('failed')
    expect(failing.status().error).toContain('a password is required')
    expect(failing.status().error).not.toContain('secret1')
    const slow = join(root, 'slow-vm.sh')
    writeFileSync(slow, '#!/bin/sh\ncat >/dev/null\nsleep 30\n')
    chmodSync(slow, 0o700)
    const waiting = new TailscaleJoin(() => [slow], 300)
    waiting.start()
    await until(() => waiting.status().state === 'failed', 3000)
    expect(waiting.status()).toMatchObject({ state: 'failed' })
  })
})
