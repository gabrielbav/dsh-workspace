/**
 * What the Host machine offers: the uvx executable that runs the local servers, and the AWS profile names the page
 * offers. Only profile names are read, never keys.
 */
import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import type { UvStatus } from '../shared.ts'

/** Where installers put uv when PATH does not have it, as with a DSH started from a desktop launcher. */
function fallbackDirs(home: string): string[] {
  return [join(home, '.local', 'bin'), join(home, '.cargo', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']
}

/**
 * Find uvx on PATH, then in the usual install directories.
 * @param env Environment to read PATH from.
 * @param home Home directory.
 * @returns Its absolute path, or undefined.
 */
export async function findUvx(env: NodeJS.ProcessEnv = process.env, home = homedir()): Promise<string | undefined> {
  const name = process.platform === 'win32' ? 'uvx.exe' : 'uvx'
  const dirs = [...(env.PATH ?? '').split(delimiter).filter(dir => dir !== ''), ...fallbackDirs(home)]
  for (const dir of new Set(dirs)) {
    const candidate = join(dir, name)
    try { await access(candidate, constants.X_OK); return candidate }
    catch { /* try the next directory */ }
  }
  return undefined
}

/**
 * Read `uvx --version`.
 * @param path Absolute uvx path.
 * @returns The version line, or undefined when it does not answer within 5 seconds.
 */
export function uvxVersion(path: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(path, ['--version'], { timeout: 5_000 }, (error, stdout) => {
      resolve(error === null ? stdout.trim().replace(/^uvx\s+/, '') || undefined : undefined)
    })
  })
}

/** Detects uvx once it is installed and remembers it; a miss is checked again on the next call. */
export function uvLocator(find: () => Promise<string | undefined> = findUvx, version: (path: string) => Promise<string | undefined> = uvxVersion) {
  let found: UvStatus | undefined
  return {
    async status(): Promise<UvStatus> {
      if (found !== undefined) return found
      const path = await find()
      if (path === undefined) return { found: false }
      const detected = await version(path)
      found = { found: true, path, ...detected === undefined ? {} : { version: detected } }
      return found
    },
    forget(): void { found = undefined },
  }
}

/**
 * Profile names from the AWS shared config and credentials files.
 * @param env Environment, for `AWS_CONFIG_FILE` and `AWS_SHARED_CREDENTIALS_FILE`.
 * @param home Home directory.
 * @returns Sorted unique names.
 */
export async function awsProfiles(env: NodeJS.ProcessEnv = process.env, home = homedir()): Promise<string[]> {
  const names = new Set<string>()
  const read = async (path: string, config: boolean): Promise<void> => {
    let text: string
    try { text = await readFile(path, 'utf8') }
    catch { return }
    for (const match of text.matchAll(/^\s*\[([^\]\r\n]+)\]\s*$/gm)) {
      const section = (match[1] ?? '').trim()
      if (config) {
        if (section === 'default') names.add('default')
        else if (section.startsWith('profile ')) names.add(section.slice('profile '.length).trim())
      } else {
        names.add(section)
      }
    }
  }
  await read(env.AWS_CONFIG_FILE ?? join(home, '.aws', 'config'), true)
  await read(env.AWS_SHARED_CREDENTIALS_FILE ?? join(home, '.aws', 'credentials'), false)
  return [...names].filter(name => PROFILE.test(name)).sort()
}

/** Profile names DSH passes on: no leading dash (it would read as a flag) and no spaces. */
export const PROFILE = /^[A-Za-z0-9_.+@=,][A-Za-z0-9_.+@=,-]{0,127}$/

/** AWS region names such as `us-east-1` or `us-gov-west-1`. */
export const REGION = /^[a-z]{2}(-[a-z]+)+-\d{1,2}$/
