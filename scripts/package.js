import { mkdirSync, readFileSync, writeFileSync, mkdtempSync, copyFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { packageHarness } from './package-worker.js'
const root = resolve(import.meta.dirname, '..'), out = join(root, 'dist')
mkdirSync(out, { recursive: true }); mkdirSync(join(root, '.work'), { recursive: true })
const pnpm = process.env.AGENT_HUB_PNPM
if (!pnpm) throw Error('Set AGENT_HUB_PNPM to pnpm.cjs')
const temporary = mkdtempSync(join(root, '.work/pack-'))
const r = spawnSync(process.execPath, [pnpm, 'pack', '--pack-destination', temporary], { cwd: root, encoding: 'utf8', windowsHide: true })
if (r.status !== 0) throw Error('Plugin packaging failed: ' + r.stderr)
const pkg = JSON.parse(readFileSync(join(root, 'package.json')))
const tgz = 'dsh-agent-hub.tgz'
copyFileSync(join(temporary, pkg.name + '-' + pkg.version + '.tgz'), join(out, tgz))
writeFileSync(join(out, tgz + '.sha256'), createHash('sha256').update(readFileSync(join(out, tgz))).digest('hex') + '  ' + tgz + '\n')
await packageHarness(root, out)
