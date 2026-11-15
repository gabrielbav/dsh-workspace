#!/usr/bin/env node
// Repoints every DSH profile's `link:` dependencies on this workspace's plugins to this checkout.
// A profile records each plugin as `link:<absolute path>/Plugins/<name>[/...]`, so a fresh clone in
// another folder (or a moved one) leaves every profile pointing at a path that no longer exists.
// Usage: node scripts/relink-profiles.mjs <workspace root> <DSH_HOME> <pnpm command...>
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const [root, dshHome, ...pnpm] = process.argv.slice(2)
if (!root || !dshHome || pnpm.length === 0) {
  console.error('usage: relink-profiles.mjs <workspace root> <DSH_HOME> <pnpm command...>')
  process.exit(2)
}
const profilesDir = join(dshHome, 'profiles')
if (!existsSync(profilesDir)) process.exit(0)

for (const name of readdirSync(profilesDir)) {
  const file = join(profilesDir, name, 'package.json')
  if (!existsSync(file)) continue
  const pkg = JSON.parse(readFileSync(file, 'utf8'))
  const changed = []
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    for (const [dep, spec] of Object.entries(pkg[field] ?? {})) {
      if (!spec.startsWith('link:')) continue
      const path = spec.slice('link:'.length)
      const at = path.lastIndexOf('/Plugins/')
      if (at < 0 || existsSync(path)) continue
      const moved = join(root, path.slice(at + 1))
      if (!existsSync(moved)) continue
      pkg[field][dep] = `link:${moved}`
      changed.push(`${dep} -> ${moved}`)
    }
  }
  if (changed.length === 0) continue
  console.log(`==> relinking profile ${name}: ${changed.join(', ')}`)
  writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`)
  execFileSync(pnpm[0], [...pnpm.slice(1), 'install'], { cwd: join(profilesDir, name), stdio: 'inherit' })
}
