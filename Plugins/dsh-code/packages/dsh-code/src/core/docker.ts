/**
 * Thin, injectable wrapper over the Docker CLI. Every Docker interaction in
 * dsh-code goes through {@link DockerCli} so the trusted host process never
 * mounts or exposes the Docker socket to a workspace, and tests can replace
 * the runner without a daemon.
 */
import { execFile, spawn } from 'node:child_process'
import { createReadStream, createWriteStream } from 'node:fs'
import { rm } from 'node:fs/promises'

/** Result of one Docker CLI invocation. */
export interface DockerResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/** Runs one `docker` argv and resolves with its exit code and captured output. */
export type DockerRunner = (args: readonly string[], options?: { readonly input?: string; readonly signal?: AbortSignal }) => Promise<DockerResult>

/** Structured failure of a Docker CLI call. */
export class DockerError extends Error {
  /**
   * @param args - the docker argv that failed.
   * @param result - exit code and output of the failed call.
   */
  constructor(readonly args: readonly string[], readonly result: DockerResult) {
    super(`docker ${args[0] ?? ''} failed (${result.code}): ${result.stderr.trim() || result.stdout.trim()}`)
    this.name = 'DockerError'
  }
}

/**
 * Create the default runner that spawns the `docker` binary.
 * @param binary - docker executable path or name.
 * @returns a runner that never rejects on non-zero exit.
 */
export function processRunner(binary = 'docker'): DockerRunner {
  return (args, options = {}) => new Promise((resolve, reject) => {
    const child = execFile(binary, [...args], { maxBuffer: 64 * 1024 * 1024, signal: options.signal }, (error, stdout, stderr) => {
      if (error !== null && typeof (error as NodeJS.ErrnoException).code === 'string') {
        reject(error)
        return
      }
      resolve({ code: error === null ? 0 : (error as { code?: number }).code ?? 1, stdout, stderr })
    })
    if (options.input !== undefined) child.stdin?.end(options.input)
  })
}

/** Docker operations used by the workspace manager. */
export class DockerCli {
  /**
   * @param run - the CLI runner.
   * @param binary - docker executable for streamed calls ({@link DockerCli.stream}).
   */
  constructor(private readonly run: DockerRunner = processRunner(), private readonly binary = 'docker') {}

  /**
   * Run docker with stdin from a file and/or stdout to a file, for Git bundles moved in and out of a workspace
   * without the host touching its checkout. A partial output file is removed on failure.
   * @param args - docker argv.
   * @param options - input file, output file and the most bytes the output may have.
   * @returns resolves on exit 0; rejects with {@link DockerError} otherwise.
   */
  stream(args: readonly string[], options: { readonly input?: string; readonly output?: string; readonly maxBytes?: number }): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.binary, [...args], { stdio: [options.input === undefined ? 'ignore' : 'pipe', options.output === undefined ? 'ignore' : 'pipe', 'pipe'] })
      let stderr = ''
      let failure: Error | undefined
      child.stderr?.setEncoding('utf8')
      child.stderr?.on('data', (chunk: string) => { if (stderr.length < 8192) stderr += chunk })
      if (options.input !== undefined && child.stdin !== null) {
        const source = createReadStream(options.input)
        source.on('error', (error) => { failure = error; child.kill() })
        source.pipe(child.stdin)
        child.stdin.on('error', () => { /* the process exited early; its exit code reports why */ })
      }
      const sink = options.output === undefined ? undefined : createWriteStream(options.output, { mode: 0o600 })
      if (sink !== undefined && child.stdout !== null) {
        let bytes = 0
        child.stdout.on('data', (chunk: Buffer) => {
          bytes += chunk.length
          if (options.maxBytes !== undefined && bytes > options.maxBytes) {
            failure = new Error(`output exceeds ${options.maxBytes} bytes`)
            child.kill()
          }
        })
        child.stdout.pipe(sink)
      }
      child.on('error', reject)
      child.on('close', (code) => {
        const finish = (): void => {
          if (failure === undefined && code === 0) { resolve(); return }
          const error = failure ?? new DockerError(args, { code: code ?? 1, stdout: '', stderr })
          if (options.output === undefined) reject(error)
          else void rm(options.output, { force: true }).finally(() => { reject(error) })
        }
        if (sink === undefined) finish()
        else sink.end(finish)
      })
    })
  }

  /**
   * Create a labelled volume if it does not exist.
   * @param name - volume name.
   * @param labels - `key=value` labels.
   * @returns whether it was created now.
   */
  async ensureVolume(name: string, labels: readonly string[]): Promise<boolean> {
    if ((await this.run(['volume', 'inspect', name])).code === 0) return false
    await this.exec(['volume', 'create', ...labels.flatMap(l => ['--label', l]), name])
    return true
  }

  /**
   * Remove a volume if present.
   * @param name - volume name.
   */
  async removeVolume(name: string): Promise<void> {
    const result = await this.run(['volume', 'rm', '-f', name])
    if (result.code !== 0 && !/no such volume/i.test(result.stderr)) throw new DockerError(['volume', 'rm', '-f', name], result)
  }

  /**
   * List volumes carrying a label, with their labels.
   * @param label - `key=value` label filter.
   * @returns volume names and labels.
   */
  async volumesWithLabel(label: string): Promise<{ name: string; labels: Record<string, string> }[]> {
    const out = await this.exec(['volume', 'ls', '--filter', `label=${label}`, '--format', '{{.Name}}'])
    const names = out === '' ? [] : out.split('\n')
    const result: { name: string; labels: Record<string, string> }[] = []
    for (const name of names) {
      const info = await this.run(['volume', 'inspect', '--format', '{{json .Labels}}', name])
      result.push({ name, labels: info.code === 0 ? JSON.parse(info.stdout.trim() || '{}') as Record<string, string> : {} })
    }
    return result
  }

  /**
   * Run docker and throw {@link DockerError} on non-zero exit.
   * @param args - docker argv.
   * @param signal - optional cancellation.
   * @returns trimmed stdout.
   */
  async exec(args: readonly string[], signal?: AbortSignal): Promise<string> {
    const result = await this.run(args, { signal })
    if (result.code !== 0) throw new DockerError(args, result)
    return result.stdout.trim()
  }

  /**
   * Run docker without throwing.
   * @param args - docker argv.
   * @param signal - optional cancellation.
   * @returns the raw result.
   */
  tryExec(args: readonly string[], signal?: AbortSignal): Promise<DockerResult> {
    return this.run(args, signal === undefined ? {} : { signal })
  }

  /** @returns the runtimes the daemon reports, or an empty list when the daemon is unreachable. */
  async runtimes(): Promise<string[]> {
    const result = await this.run(['info', '--format', '{{json .Runtimes}}'])
    if (result.code !== 0) return []
    const parsed: unknown = JSON.parse(result.stdout.trim() || '{}')
    return parsed !== null && typeof parsed === 'object' ? Object.keys(parsed) : []
  }

  /**
   * List container ids carrying a label.
   * @param label - `key=value` label filter.
   * @returns container ids, including stopped containers.
   */
  async containersWithLabel(label: string): Promise<string[]> {
    const out = await this.exec(['ps', '-a', '--no-trunc', '--filter', `label=${label}`, '--format', '{{.ID}}'])
    return out === '' ? [] : out.split('\n')
  }

  /**
   * Read container labels and state.
   * @param id - container id or name.
   * @returns labels and whether it is running, or undefined when absent.
   */
  async inspect(id: string): Promise<{ labels: Record<string, string>; running: boolean; runtime: string } | undefined> {
    const args = ['inspect', '--type', 'container', '--format', '{{json .Config.Labels}}|{{.State.Running}}|{{.HostConfig.Runtime}}', id]
    const result = await this.run(args)
    // Only Docker's own answer means the container is gone; a failed connection (a remote VM out of reach, a daemon
    // restarting) must not look like it, or healthy workspaces would be recreated.
    if (result.code !== 0 && /no such (container|object)/i.test(result.stderr)) return undefined
    if (result.code !== 0) throw new DockerError(args, result)
    const [labels, running, runtime] = result.stdout.trim().split('|')
    return { labels: JSON.parse(labels ?? '{}') as Record<string, string>, running: running === 'true', runtime: runtime ?? '' }
  }

  /**
   * Remove a container if present.
   * @param id - container id or name.
   */
  async removeContainer(id: string): Promise<void> {
    const result = await this.run(['rm', '-f', '-v', id])
    if (result.code !== 0 && !/No such container/i.test(result.stderr)) throw new DockerError(['rm', '-f', '-v', id], result)
  }

  /**
   * Ensure a network exists.
   * @param name - network name.
   * @param args - extra `network create` flags.
   */
  async ensureNetwork(name: string, args: readonly string[]): Promise<void> {
    const found = await this.run(['network', 'inspect', name])
    if (found.code === 0) return
    await this.exec(['network', 'create', ...args, name])
  }

  /**
   * Remove a network if present.
   * @param name - network name.
   */
  async removeNetwork(name: string): Promise<void> {
    const result = await this.run(['network', 'rm', name])
    if (result.code !== 0 && !/not found|No such network/i.test(result.stderr)) throw new DockerError(['network', 'rm', name], result)
  }
}
