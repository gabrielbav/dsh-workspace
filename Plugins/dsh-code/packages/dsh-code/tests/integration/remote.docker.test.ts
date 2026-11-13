/**
 * Code against a remote Docker host over SSH. Point it at any Linux VM with Docker and gVisor (on macOS, the Colima
 * VM's own SSH server works the same way):
 *   DSH_CODE_REMOTE_TESTS=1 DSH_CODE_REMOTE_HOST=127.0.0.1 DSH_CODE_REMOTE_PORT=… DSH_CODE_REMOTE_USER=…
 *   DSH_CODE_REMOTE_KEY=/path/to/key DSH_CODE_REMOTE_HOSTKEY=SHA256:… pnpm run test:docker
 * The fingerprint must come from the VM itself (its console, or ssh-keygen -l on /etc/ssh/ssh_host_*_key.pub).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { request } from 'node:http'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { OWNER_LABEL } from '../../src/core/container-spec.ts'
import { DockerCli, processRunner } from '../../src/core/docker.ts'
import { pinHostKey, validateRemote, writeRemoteFiles } from '../../src/core/remote.ts'
import { WorkspaceManager, type WorkspaceRecord } from '../../src/core/workspaces.ts'
import { DEFAULT_ALLOW } from '../../src/egress/policy.ts'
import { relayConnection } from '../../src/host/preview.ts'
import { FsHelperClient } from '../../src/host/fs-helper-client.ts'
import { FS_HELPER_PATH } from '../../src/host/fs-container.ts'

const env = process.env
const enabled = env.DSH_CODE_REMOTE_TESTS === '1'

describe.runIf(enabled)('workspaces on a remote Docker host over SSH', () => {
  // A /var/folders temp dir on macOS is fine here: nothing of dataDir is mounted into a container on the VM.
  const root = mkdtempSync(join(tmpdir(), 'dsh-code-rt-'))
  const host = enabled ? validateRemote({ host: env.DSH_CODE_REMOTE_HOST!, port: Number(env.DSH_CODE_REMOTE_PORT ?? 22), user: env.DSH_CODE_REMOTE_USER!, identityFile: env.DSH_CODE_REMOTE_KEY!, hostKey: env.DSH_CODE_REMOTE_HOSTKEY! }) : undefined
  const dir = join(root, 'data', 'remote')
  const which = (name: string): string => execFileSync('sh', ['-c', `command -v ${name}`]).toString().trim()
  const dockerBinary = enabled ? writeRemoteFiles(dir, host!, { ssh: which('ssh'), docker: which('docker') }) : 'docker'
  const docker = new DockerCli(processRunner(dockerBinary), dockerBinary)
  const namespace = `dsh-code-rt-${process.pid}`
  const origin = join(root, 'origin.git')
  const manager = new WorkspaceManager({
    namespace, dataDir: join(root, 'data'), image: 'dsh-code-worker:0.3.0', proxyImage: 'node:24-alpine',
    proxyDir: resolve(import.meta.dirname, '../../src/egress'), workerDir: resolve(import.meta.dirname, '../../worker'),
    limits: { cpus: 1, memoryMb: 1024, pids: 256, tmpMb: 256 }, policy: { mode: 'allowlist', allow: DEFAULT_ALLOW, privateAllow: [], ports: [80, 443] },
    uid: 1000, gid: 1000, maxWorkspaces: 4, previewPorts: [8000],
    ...enabled ? { remote: { host: host!, dir, dockerBinary } } : {},
  }, docker)
  const repo = { fullName: 'local/origin', cloneUrl: `file://${origin}` }
  let w: WorkspaceRecord

  beforeAll(async () => {
    const seed = join(root, 'seed')
    execFileSync('git', ['init', '-q', '-b', 'main', seed])
    writeFileSync(join(seed, 'README.md'), '# remote seed\n')
    execFileSync('git', ['-C', seed, 'add', '.'])
    execFileSync('git', ['-C', seed, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'seed'])
    execFileSync('git', ['clone', '-q', '--bare', seed, origin])
    await manager.reconcile()
  }, 120_000)

  afterAll(async () => {
    await manager.delete('remote-a').catch(() => undefined)
    for (const id of await docker.containersWithLabel(`${OWNER_LABEL}=${namespace}`).catch(() => [] as string[])) await docker.removeContainer(id).catch(() => undefined)
    await docker.tryExec(['network', 'rm', manager.internalNetwork, manager.egressNetwork])
    for (const volume of await docker.volumesWithLabel(`${OWNER_LABEL}=${namespace}`).catch(() => [])) await docker.removeVolume(volume.name).catch(() => undefined)
    await docker.tryExec(['rm', '-f', manager.proxyContainer])
    rmSync(root, { recursive: true, force: true })
  }, 120_000)

  it('refuses a server whose host key is not the pinned fingerprint', async () => {
    await expect(pinHostKey(join(root, 'wrong'), { ...host!, hostKey: 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' })).rejects.toMatchObject({ field: 'hostKey' })
  }, 60_000)

  it('passes the self test over SSH, with checkouts in volumes on the VM', async () => {
    const report = await manager.selfTest()
    expect(report.checks.filter(c => !c.ok)).toEqual([])
    expect(report.checks.map(c => c.id)).toEqual(expect.arrayContaining(['remote', 'docker', 'runtime', 'image', 'isolation', 'writable', 'worker']))
    expect(report.checks.map(c => c.id)).not.toContain('data-dir')
  }, 120_000)

  it('provisions on the VM: gVisor, non-root, checkout imported from a bundle, nothing of it on this computer', async () => {
    w = await manager.provision('remote-a', repo, 'main')
    expect(w).toMatchObject({ storage: 'volume', backend: `ssh://${host!.user}@${host!.host}:${host!.port}` })
    expect(await manager.runInside(w, ['sh', '-c', 'dmesg | head -n 1'])).toMatch(/gVisor/)
    expect(await manager.runInside(w, ['id', '-u'])).toBe('1000')
    expect(await manager.runInside(w, ['cat', 'README.md'])).toBe('# remote seed')
    expect(await manager.runInside(w, ['git', 'rev-parse', '--abbrev-ref', 'HEAD'])).toBe(w.workingBranch)
    expect(readdirSync(w.path)).toEqual([])
  }, 180_000)

  it('runs the file helper and the preview relay through the SSH wrapper', async () => {
    await manager.runInside(w, ['sh', '-c', 'echo through-ssh > note.txt'])
    const client = new FsHelperClient([manager.dockerBinary, ...manager.execArgv(w, ['node', FS_HELPER_PATH, w.path], w.path, {}, false)], w.path)
    try {
      expect(await client.call({ op: 'readText', target: { targetKey: `${w.path}/note.txt` as never, displayPath: 'note.txt' } })).toBe('through-ssh\n')
    } finally {
      client.close()
    }
    await docker.exec(['exec', '-d', w.containerName, 'python3', '-m', 'http.server', '8000', '--bind', '127.0.0.1', '--directory', '/tmp'])
    await new Promise(r => setTimeout(r, 2000))
    const argv = await manager.previewRelayArgv('remote-a', 8000)
    const status = await new Promise<number>((resolveStatus, reject) => {
      const req = request({ host: 'localhost', port: 8000, path: '/', createConnection: () => relayConnection(argv, manager.dockerBinary) as never }, (res) => { res.resume(); resolveStatus(res.statusCode ?? 0) })
      req.on('error', reject)
      req.end()
    })
    expect(status).toBe(200)
  }, 120_000)

  it('filters egress with the proxy on the VM and applies a session grant uploaded to its policy volume', async () => {
    expect(await manager.runInside(w, ['sh', '-c', 'curl -s -o /dev/null -w "%{http_code}" --max-time 10 http://example.org/'])).toBe('403')
    await manager.grantNetwork('remote-a', 'example.org')
    expect(await manager.runInside(w, ['sh', '-c', 'curl -s -o /dev/null -w "%{http_code}" --max-time 15 http://example.org/ || true'])).not.toBe('403')
    await manager.setNetworkGrants('remote-a', [])
    await new Promise(r => setTimeout(r, 2500))
    expect(await manager.runInside(w, ['sh', '-c', 'curl -s -o /dev/null -w "%{http_code}" --max-time 10 http://example.org/'])).toBe('403')
  }, 120_000)

  it('commits on the VM and pushes from this computer, then deletes everything on the VM', async () => {
    await manager.runInside(w, ['sh', '-c', 'mkdir -p src && echo x > src/a.txt'])
    const pushed = await manager.commitAndPush('remote-a', 'remote change')
    expect(execFileSync('git', ['-C', origin, 'rev-parse', `refs/heads/${w.workingBranch}`]).toString().trim()).toBe(pushed.sha)
    await manager.delete('remote-a')
    expect(await docker.inspect(w.containerName)).toBeUndefined()
    expect((await docker.tryExec(['volume', 'inspect', w.volume!])).code).not.toBe(0)
  }, 120_000)
})
