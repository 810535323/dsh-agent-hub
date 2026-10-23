import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { dataHome, workerHome } from '../src/installation.js'
import { writeConfig } from '../src/util.js'
import { Hub } from '../src/hub.js'
import { Store } from '../src/store.js'
import { pairWorker, workerControl } from '../src/pairing.js'
import { startWorkerRuntime } from '../src/worker-runtime.js'
import { startHarnessWorker } from '../src/harness-plugin.js'
import { temp, until, FakeHarnessContext, autoReply } from './helpers.js'

test('stable install names reuse existing Harness data in place and never adopt Codex-only credentials', t => {
  const userHome = temp(t), options = { userHome, env: {} }, legacy = join(userHome, '.agent-hub-worker')
  assert.equal(dataHome(options), join(userHome, '.dsh/agent-hub'))
  writeConfig(join(userHome, '.dsh/agent-hub-v2/config.json'), { adminToken: 'preserved' })
  assert.equal(dataHome(options), join(userHome, '.dsh/agent-hub-v2'))
  writeConfig(join(legacy, 'config.json'), { runtimes: ['codex'], token: 'keep-private' })
  assert.notEqual(workerHome('harness', options), legacy)
  assert.throws(() => workerHome('codex', options), /harness-only/)
  writeConfig(join(legacy, 'config.json'), { runtimes: ['harness', 'codex'], token: 'keep-private' })
  assert.equal(workerHome('harness', options), legacy)
  assert.equal(JSON.parse(readFileSync(join(legacy, 'config.json'))).token, 'keep-private')
})

async function fixture(t) {
  const dir = temp(t), home = join(dir, 'worker'), ctx = new FakeHarnessContext()
  const hub = await new Hub({ dbPath: join(dir, 'hub.sqlite'), adminToken: 'test-only', port: 0 }).listen()
  hub.bindMaster({ session_id: 'main', bot_id: 'wx', target_id: 'test' }); t.after(() => hub.close())
  const input = { hub: 'http://127.0.0.1:' + hub.server.address().port, code: hub.createPair('main').code, name: 'Harness', cwd: dir }
  const device = await pairWorker(home, input)
  const config = JSON.parse(readFileSync(join(home, 'config.json')))
  return { dir, home, ctx, hub, config, device, input }
}

test('pairing defaults to Harness; a direct Codex request does not consume the code', async t => {
  const { dir, home, hub, input } = await fixture(t), code = hub.createPair('main').code
  await assert.rejects(pairWorker(join(dir, 'other'), { ...input, code, runtimes: ['codex'] }), /harness-only/)
  await pairWorker(join(dir, 'other'), { ...input, code })
  assert.deepEqual(JSON.parse(readFileSync(join(home, 'config.json'))).runtimes, ['harness'])
})

test('mixed binding migrates to Harness without changing device, credentials, fixed Session or old receipts', async t => {
  const { home, config, hub, ctx } = await fixture(t)
  config.runtimes = ['codex', 'harness']; config.codex = 'must-never-spawn.exe'; writeConfig(join(home, 'config.json'), config)
  ctx.makeSession('fixed-harness')
  const store = new Store(join(home, config.database))
  store.put('bindings', { id: 'harness', version: 3, session_id: 'fixed-harness', ready: true })
  store.put('bindings', { id: 'codex', version: 2, session_id: 'old-thread', ready: true })
  store.received({ message_id: 'old-receipt' }, { persisted: true }); store.close()
  const plugin = startHarnessWorker(ctx, { workerHome: home }); t.after(() => plugin.close())
  await until(() => hub.listDevices('main')[0]?.endpoints[0]?.ready)
  const saved = JSON.parse(readFileSync(join(home, 'config.json')))
  assert.equal(saved.device_id, config.device_id); assert.equal(saved.token, config.token)
  assert.deepEqual(saved.runtimes, ['harness']); assert.equal(saved.codex, undefined)
  assert.equal(plugin.worker.endpoints().length, 1)
  assert.equal(plugin.worker.endpoints()[0].session_id, 'fixed-harness')
  assert.equal(plugin.worker.endpoints()[0].binding_version, 3)
  assert.equal(plugin.worker.store.get('bindings', 'codex').session_id, 'old-thread')
  assert.equal(plugin.worker.store.get('bindings', 'codex').ready, false)
  assert.equal(plugin.worker.store.receipt('old-receipt').persisted, true)
  assert.equal((await workerControl(home, 'communication.check')).connected, true)
})

test('unfinished retired execution blocks migration and leaves credentials and ledger unchanged', async t => {
  const { home, config } = await fixture(t)
  config.runtimes = ['harness', 'codex']; writeConfig(join(home, 'config.json'), config)
  const store = new Store(join(home, config.database)); store.put('tasks', { id: 'old', runtime: 'codex', status: 'starting' }); store.close()
  await assert.rejects(startWorkerRuntime({ home }), /legacy-runtime-tasks-require-review/)
  assert.deepEqual(JSON.parse(readFileSync(join(home, 'config.json'))), config)
  assert.equal(existsSync(join(home, 'worker.pid.json')), false)
})

test('old Codex-only binding is not taken over by the Harness plugin', async t => {
  const { home, config, ctx } = await fixture(t)
  config.runtimes = ['codex']; writeConfig(join(home, 'config.json'), config)
  const plugin = startHarnessWorker(ctx, { workerHome: home }); t.after(() => plugin.close())
  await until(() => plugin.status().state === 'error:worker-profile-does-not-provide-harness')
  assert.equal(existsSync(join(home, 'worker.pid.json')), false)
  assert.deepEqual(JSON.parse(readFileSync(join(home, 'config.json'))), config)
})

test('Hub hides and rejects retired Codex endpoints but preserves their historical records', async t => {
  const { hub, config } = await fixture(t)
  const old = { id: config.device_id + ':codex', device_id: config.device_id, runtime: 'codex', ready: true, session_id: 'old', binding_version: 1 }
  hub.store.put('endpoints', old)
  assert.equal(hub.listDevices('main')[0].endpoints.length, 0)
  assert.throws(() => hub.dispatch('main', { endpoint_id: old.id, prompt: 'use Codex' }), /harness-only/)
  assert.deepEqual(hub.store.get('endpoints', old.id), old)
  assert.equal(hub.store.all('tasks').length, 0)
})
