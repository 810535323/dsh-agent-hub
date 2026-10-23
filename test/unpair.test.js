import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { WebSocket } from 'ws'
import { Hub } from '../src/hub.js'
import { Worker } from '../src/worker.js'
import { Store } from '../src/store.js'
import { pairWorker, unpairWorker } from '../src/pairing.js'
import { postJson } from '../src/transport.js'
import { autostartPaths } from '../src/autostart.js'
import { temp, until, FakeAdapter } from './helpers.js'

async function setup(t, running = false) {
  const dir = temp(t), home = join(dir, 'worker')
  const hub = await new Hub({ dbPath: join(dir, 'hub.sqlite'), adminToken: 'admin', port: 0 }).listen()
  hub.bindMaster({ session_id: 'main', bot_id: 'wx', target_id: 'person' })
  await pairWorker(home, { hub: 'http://127.0.0.1:' + hub.server.address().port, code: hub.createPair('main').code, name: 'Unpair test', cwd: dir, runtimes: ['harness'], local_port: 0 })
  const config = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'))
  const adapter = new FakeAdapter()
  const worker = running ? await new Worker({ dbPath: join(home, config.database), config, adapters: { harness: adapter }, localPort: 0, home }).start() : null
  t.after(async () => { await worker?.close(); await hub.close() })
  if (worker) await until(() => hub.listDevices('main')[0]?.endpoints[0]?.ready)
  return { dir, home, hub, config, worker, adapter }
}

test('device revocation rejects cross-master access and old WebSocket credentials; duplicate self-unpair gets the same receipt', async (t) => {
  const { hub, config } = await setup(t, true)
  assert.throws(() => hub.unpairDevice('another-master', config.device_id), /unknown-device/)
  const receipt = hub.unpairDevice('main', config.device_id)
  assert.ok(receipt.receipt_id)
  assert.equal(hub.listDevices('main').length, 0)
  assert.equal(hub.isOnline(config.device_id), false)
  assert.throws(() => hub.dispatch('main', { endpoint_id: config.device_id + ':harness', prompt: 'forbidden' }), /unknown-endpoint/)
  const rejected = await postJson(config.hub + '/v2/device/unpair', { device_id: config.device_id }, { headers: { Authorization: 'Bearer wrong' } })
  assert.equal(rejected.status, 401)
  const retry = await postJson(config.hub + '/v2/device/unpair', { device_id: config.device_id }, { headers: { Authorization: 'Bearer ' + config.token } })
  assert.deepEqual(retry.body.receipt, receipt)
  const ws = new WebSocket(config.hub.replace('http:', 'ws:') + '/v2/worker?device_id=' + config.device_id, { headers: { Authorization: 'Bearer ' + config.token } })
  ws.on('error', () => {})
  const status = await new Promise((resolve) => ws.on('unexpected-response', (_request, response) => { response.resume(); ws.terminate(); resolve(response.statusCode) }))
  assert.equal(status, 401)
  assert.ok(hub.store.get('endpoints', config.device_id + ':harness').session_id)
})

test('unpair blocks active and uncertain work; a completed task and its Session evidence are retained', async (t) => {
  const { home, hub, worker, adapter, config } = await setup(t, true)
  const task = hub.dispatch('main', { endpoint_id: config.device_id + ':harness', prompt: 'real active task' })
  await until(() => adapter.runs.length === 1)
  assert.throws(() => hub.unpairDevice('main', config.device_id), /runtime-has-active-tasks/)
  await assert.rejects(worker.unpair(), /runtime-has-active-tasks/)
  worker.store.put('tasks', { ...worker.store.get('tasks', task.id), status: 'uncertain' })
  await assert.rejects(worker.unpair(), /runtime-has-active-tasks/)
  assert.equal(existsSync(join(home, 'config.json')), true)
  adapter.finish(task.id)
  await until(() => hub.task('main', task.id).status === 'completed')
  const receipt = await worker.unpair()
  assert.equal(receipt.unpaired, true)
  assert.equal(existsSync(join(home, 'config.json')), false)
  assert.equal(worker.store.get('tasks', task.id).status, 'completed')
  assert.equal(hub.task('main', task.id).status, 'completed')
  assert.ok(worker.store.get('bindings', 'harness').session_id)
})

test('lost revocation response preserves local binding; a new SQLite reader and retry see the committed receipt', async (t) => {
  const { home, hub, config, dir } = await setup(t)
  const original = hub.handleHttp.bind(hub); let dropped = false
  hub.handleHttp = async (req, res) => {
    if (req.url === '/v2/device/unpair' && !dropped) { dropped = true; res.end = () => { res.destroy(); return res } }
    return original(req, res)
  }
  await assert.rejects(unpairWorker(home))
  assert.equal(existsSync(join(home, 'config.json')), true)
  const committed = hub.store.get('device_revocations', config.device_id)
  assert.ok(committed.receipt_id)
  const mirror = new Store(join(dir, 'hub.sqlite'))
  assert.deepEqual(mirror.get('device_revocations', config.device_id), committed); mirror.close()
  const result = await unpairWorker(home)
  assert.equal(result.receipt_id, committed.receipt_id)
  assert.equal(existsSync(join(home, 'config.json')), false)
  assert.equal(JSON.parse(readFileSync(join(home, 'last-unpair.json'))).receipt_id, committed.receipt_id)
  assert.deepEqual(await unpairWorker(home), { unpaired: true, already_unpaired: true })
})

test('CLI unpair cleans only its startup registration and credentials, retaining its native bindings and ledger', async (t) => {
  const { dir, home, config, hub } = await setup(t)
  const previous = process.env.APPDATA; process.env.APPDATA = join(dir, 'appdata')
  t.after(() => { if (previous === undefined) delete process.env.APPDATA; else process.env.APPDATA = previous })
  const store = new Store(join(home, config.database)); store.put('bindings', { id: 'harness', session_id: 'retained-session', version: 1 }); store.close()
  const { stdout } = await promisify(execFile)(process.execPath, ['bin/agent-hub.js', 'unpair', '--home', home], { windowsHide: true })
  assert.equal(JSON.parse(stdout).unpaired, true)
  assert.equal(existsSync(join(home, 'config.json')), false)
  assert.ok(hub.store.get('devices', config.device_id).revoked_at)
  const retained = new Store(join(home, config.database)); assert.equal(retained.get('bindings', 'harness').session_id, 'retained-session'); retained.close()
})

test('failed host revocation keeps local credentials and autostart intact', async (t) => {
  const { dir, home, hub, config } = await setup(t)
  const previous = process.env.APPDATA; process.env.APPDATA = join(dir, 'appdata')
  t.after(() => { if (previous === undefined) delete process.env.APPDATA; else process.env.APPDATA = previous })
  hub.store.put('tasks', { id: 'uncertain-native-submission', device_id: config.device_id, status: 'uncertain' })
  await assert.rejects(unpairWorker(home), /runtime-has-active-tasks/)
  assert.equal(existsSync(join(home, 'config.json')), true)
  assert.equal(hub.store.get('devices', config.device_id).revoked_at, undefined)
})
