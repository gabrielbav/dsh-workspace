import { afterAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fingerprints, pinHostKey, RemoteError, sshConfig, validateRemote, writeRemoteFiles, type RemoteHost } from '../src/core/remote.ts'

const root = mkdtempSync(join(tmpdir(), 'dsh-code-remote-'))
afterAll(() => { rmSync(root, { recursive: true, force: true }) })

// A real host key, made here, stands in for the VM's.
execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(root, 'hostkey')])
const pub = readFileSync(join(root, 'hostkey.pub'), 'utf8').trim().split(' ').slice(0, 2).join(' ')
const fingerprint = /SHA256:[A-Za-z0-9+/]+/.exec(execFileSync('ssh-keygen', ['-l', '-E', 'sha256', '-f', join(root, 'hostkey.pub')]).toString())![0]

const good: RemoteHost = { host: 'vm.example.org', port: 22, user: 'azureuser', identityFile: '/Users/me/.ssh/id_ed25519', hostKey: fingerprint }

function fakeKeyscan(lines: string): string {
  const path = join(root, `keyscan-${Math.random().toString(36).slice(2)}`)
  writeFileSync(path, `#!/bin/sh\ncat <<'X'\n${lines}\nX\n`)
  chmodSync(path, 0o700)
  return path
}

describe('remote Docker host settings', () => {
  it('accepts host names, IPs, logins, absolute key paths and SHA256 fingerprints', () => {
    expect(validateRemote({ ...good, host: ' vm.example.org ' }).host).toBe('vm.example.org')
    expect(validateRemote({ ...good, host: '20.1.2.3' }).host).toBe('20.1.2.3')
    expect(validateRemote({ ...good, host: '2001:db8::1' }).host).toBe('2001:db8::1')
    expect(validateRemote({ ...good, user: 'ec2-user' }).user).toBe('ec2-user')
  })

  it('refuses anything that could inject into the SSH config or the wrapper scripts', () => {
    const bad: [Partial<RemoteHost>, keyof RemoteHost][] = [
      [{ host: 'vm.example.org\n  ProxyCommand evil' }, 'host'], [{ host: '-oProxyCommand=x' }, 'host'], [{ host: '' }, 'host'],
      [{ port: 0 }, 'port'], [{ port: 70000 }, 'port'],
      [{ user: 'root; rm' }, 'user'], [{ user: '-l' }, 'user'],
      [{ identityFile: 'id_rsa' }, 'identityFile'], [{ identityFile: '/a b/id' }, 'identityFile'], [{ identityFile: '/x/../id' }, 'identityFile'],
      [{ hostKey: 'ssh-ed25519 AAAA' }, 'hostKey'], [{ hostKey: 'SHA256:short' }, 'hostKey'],
    ]
    for (const [patch, field] of bad) {
      let error: unknown
      try { validateRemote({ ...good, ...patch }) } catch (e) { error = e }
      expect(error, JSON.stringify(patch)).toBeInstanceOf(RemoteError)
      expect((error as RemoteError).field).toBe(field)
    }
  })

  it('writes an SSH config that pins the host key, never prompts, forwards nothing and reuses one connection', () => {
    const config = sshConfig('/data/remote', good)
    for (const line of ['HostName vm.example.org', 'User azureuser', 'IdentityFile /Users/me/.ssh/id_ed25519', 'IdentitiesOnly yes', 'StrictHostKeyChecking yes',
      'UserKnownHostsFile /data/remote/known_hosts', 'GlobalKnownHostsFile /dev/null', 'BatchMode yes', 'ForwardAgent no', 'ClearAllForwardings yes', 'ControlPath /data/remote/cm']) {
      expect(config).toContain(line)
    }
  })

  it('generates owner-only wrappers that use only Code\'s SSH config', () => {
    const dir = join(root, 'files')
    const docker = writeRemoteFiles(dir, good, { ssh: '/usr/bin/ssh', docker: '/usr/local/bin/docker' })
    expect(readFileSync(docker, 'utf8')).toContain('DOCKER_HOST=ssh://dsh-code-remote')
    expect(readFileSync(join(dir, 'bin', 'ssh'), 'utf8')).toContain(`exec /usr/bin/ssh -F ${join(dir, 'ssh_config')} "$@"`)
    for (const file of [docker, join(dir, 'bin', 'ssh'), join(dir, 'ssh_config'), join(dir, 'known_hosts')]) expect(statSync(file).mode & 0o077, file).toBe(0)
  })

  it('pins only the key whose fingerprint the user gave, and refuses a server without it', async () => {
    expect((await fingerprints([`vm.example.org ${pub}`]))[0]).toMatchObject({ fingerprint, type: 'ED25519' })
    const dir = join(root, 'pin')
    writeRemoteFiles(dir, good, { ssh: '/usr/bin/ssh', docker: 'docker' })
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(root, 'other')])
    const other = readFileSync(join(root, 'other.pub'), 'utf8').trim().split(' ').slice(0, 2).join(' ')
    await pinHostKey(dir, good, { sshKeyscan: fakeKeyscan(`vm.example.org ${other}\nvm.example.org ${pub}`) })
    expect(readFileSync(join(dir, 'known_hosts'), 'utf8').trim()).toBe(`vm.example.org ${pub}`)
    await expect(pinHostKey(join(root, 'pin'), good, { sshKeyscan: fakeKeyscan(`vm.example.org ${other}`) })).rejects.toMatchObject({ field: 'hostKey' })
    // The earlier pin is gone after a failed check.
    expect(readFileSync(join(dir, 'known_hosts'), 'utf8')).toBe('')
    // Without a remote folder the check still reports the key, not a file error.
    await expect(pinHostKey(join(root, 'missing'), good, { sshKeyscan: fakeKeyscan(`vm.example.org ${other}`) })).rejects.toMatchObject({ field: 'hostKey' })
    await expect(pinHostKey(join(root, 'pin'), good, { sshKeyscan: fakeKeyscan('') })).rejects.toMatchObject({ field: 'connection' })
  })
})
