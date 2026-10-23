import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { Hub } from '../src/hub.js'
import { Worker } from '../src/worker.js'
import { temp, until, FakeAdapter } from './helpers.js'
import { Store } from '../src/store.js'

test('cold Worker recovery reconciles an exact completed turn instead of submitting again', async (t) => {
  const dir = temp(t); const hub = await new Hub({ dbPath: join(dir, 'hub.sqlite'), adminToken: 'x', port: 0 }).listen()
  hub.bindMaster({ session_id: 'main', bot_id: 'wx', target_id: 'person' })
  const device = hub.enroll({ code: hub.createPair('main').code, name: 'cold' })
  const task = { id: 'known-task', attempt_id: 'attempt', binding_version: 1, runtime: 'harness', session_id: 'saved-session', master_id: 'main', device_id: device.device_id, status: 'running', native_turn_id: 'exact-turn', prompt: 'do not replay' }
  hub.store.put('tasks', task)
  const seed = new Store(join(dir, 'worker.sqlite'))
  seed.put('tasks', task); seed.put('bindings', { id: 'harness', version: 1, session_id: 'saved-session', ready: true }); seed.close()
  const adapter = new FakeAdapter(); adapter.results.set(task.id, { status: 'completed', answer: 'recovered result' })
  const worker = await new Worker({ dbPath: join(dir, 'worker.sqlite'), config: { hub: 'http://127.0.0.1:' + hub.server.address().port, ...device, local_token: 'local', cwd: dir }, adapters: { harness: adapter }, localPort: 0 }).start()
  try {
    await until(() => hub.task('main', task.id).status === 'completed')
    assert.equal(adapter.runs.length, 0)
    assert.equal(hub.task('main', task.id).result.answer, 'recovered result')
  } finally { await worker.close(); await hub.close() }
})

test('unknown native submission stays uncertain and blocks later same-session work', async (t) => {
  const dir = temp(t); const hub = await new Hub({ dbPath: join(dir, 'hub.sqlite'), adminToken: 'x', port: 0 }).listen()
  hub.bindMaster({ session_id: 'main', bot_id: 'wx', target_id: 'person' })
  const device = hub.enroll({ code: hub.createPair('main').code, name: 'unknown' })
  const task = { id: 'unknown-task', attempt_id: 'attempt', binding_version: 1, runtime: 'harness', session_id: 'saved-session', master_id: 'main', device_id: device.device_id, status: 'starting', prompt: 'do not replay' }
  hub.store.put('tasks', task)
  const seed = new Store(join(dir, 'worker.sqlite')); seed.put('tasks', task); seed.put('bindings', { id: 'harness', version: 1, session_id: 'saved-session', ready: true }); seed.close()
  const adapter = new FakeAdapter()
  const worker = await new Worker({ dbPath: join(dir, 'worker.sqlite'), config: { hub: 'http://127.0.0.1:' + hub.server.address().port, ...device, local_token: 'local', cwd: dir }, adapters: { harness: adapter }, localPort: 0 }).start()
  try {
    await until(() => hub.task('main', task.id).status === 'uncertain')
    assert.equal(adapter.runs.length, 0)
    assert.equal(worker.store.get('tasks', task.id).status, 'uncertain')
    assert.equal(hub.store.get('mailbox', task.id).state, 'pending')
  } finally { await worker.close(); await hub.close() }
})

test('Hub restart retains identity and awaits worker reconciliation without offline redispatch', async (t) => {
  const dir = temp(t); const path = join(dir, 'hub.sqlite')
  let hub = new Hub({ dbPath: path, adminToken: 'x' })
  hub.store.put('tasks', { id: 'pending', attempt_id: 'a', binding_version: 1, status: 'dispatched', device_id: 'd', master_id: 'm' })
  hub.store.enqueue({ version: 2, message_id: 'dispatch', type: 'task.dispatch', task_id: 'pending', attempt_id: 'a', binding_version: 1, payload: {} })
  hub.store.close()
  hub = new Hub({ dbPath: path, adminToken: 'x' })
  try {
    assert.equal(hub.store.get('tasks', 'pending').status, 'uncertain')
    assert.equal(hub.store.get('tasks', 'pending').connection_lost, true)
    assert.equal(hub.store.pending().length, 1)
  } finally { hub.store.close() }
})
