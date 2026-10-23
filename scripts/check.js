import { readdirSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
function walk(dir) { return readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith('.js') ? [join(dir, e.name)] : []) }
for (const file of ['src', 'bin', 'scripts', 'test'].filter(existsSync).flatMap(walk)) {
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
  if (r.status !== 0) { process.stderr.write(r.stderr); process.exit(1) }
}
console.log('JavaScript syntax checks passed')
