import test from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, writeFileSync, unlinkSync, appendFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { checkPublic, publicEntries } from '../scripts/check-public.js'
import { temp } from './helpers.js'

function sourceCopy(t) {
  const directory = temp(t), root = resolve(import.meta.dirname, '..')
  for (const entry of publicEntries) cpSync(join(root, entry), join(directory, entry), { recursive: true })
  return directory
}

test('publication audit rejects operational keys, live addresses and nonempty deployment defaults', t => {
  const root = sourceCopy(t)
  checkPublic(root)
  const key = join(root, 'assets/operator.key')
  writeFileSync(key, 'operator material must not enter a public archive')
  assert.throws(() => checkPublic(root), /Operator data or key/)
  unlinkSync(key)
  const diagnostic = join(root, 'src/diagnostic.js')
  writeFileSync(diagnostic, `export const operator = '${[8, 8, 8, 8].join('.')}'\n`)
  assert.throws(() => checkPublic(root), /Non-example IP address/)
  unlinkSync(diagnostic)
  writeFileSync(join(root, 'deployment.json'), JSON.stringify({ hub: 'https://example.com' }))
  assert.throws(() => checkPublic(root), /Public deployment defaults must remain empty/)
})

test('public DSH source keeps its native entry points and prevents a controller/runtime import cycle', t => {
  const root = sourceCopy(t)
  appendFileSync(join(root, 'src/hub-runtime.js'), "\nimport './plugin.js'\n")
  assert.throws(() => checkPublic(root), /Circular local import/)
})
