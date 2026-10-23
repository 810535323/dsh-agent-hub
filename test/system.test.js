import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { Hub } from '../src/hub.js'
import { Worker } from '../src/worker.js'
import { Store } from '../src/store.js'
import { frame } from '../src/protocol.js'
import { temp, until, FakeAdapter } from './helpers.js'

async function setup(t, runtimes = ['harness']) {
  const dir = temp(t)
  const hub = await new Hub({ dbPath: join(dir, 'hub.sqlite'), adminToken: 'admin', port: 0 }).listen()
  hub.bindMaster({ session_id: 'master', bot_id: 'wx', target_id: 'person' })
  const pair = hub.createPair('master')
  const enrollment = hub.enroll({ code: pair.code, name: '测试设备' })
  const adapters = Object.fromEntries(runtimes.map((r) => [r, new FakeAdapter()]))
  const config = { hub: 'http://127.0.0.1:' + hub.server.address().port, ...enrollment, local_token: 'local', cwd: dir }
  const worker = await new Worker({ dbPath: join(dir, 'worker.sqlite'), config, adapters, localPort: 0 }).start()
  t.after(async () => { await worker.close(); await hub.close() })
  await until(() => hub.listDevices('master')[0]?.endpoints.length === runtimes.length && hub.listDevices('master')[0].online)
  return { hub, worker, adapters, config, dir, endpoint: enrollment.device_id + ':' + runtimes[0] }
}

test('fixed Harness Session serializes tasks and sends result metadata only', async (t) => {
  const { hub, worker, adapters, endpoint } = await setup(t)
  const a = hub.dispatch('master', { endpoint_id: endpoint, prompt: 'first private task' })
  const b = hub.dispatch('master', { endpoint_id: endpoint, prompt: 'second task' })
  await until(() => adapters.harness.runs.length === 1)
  adapters.harness.finish(a.id, { status: 'completed', answer: 'final', stderr: 'SECRET OUTPUT', reasoning: 'PRIVATE THOUGHT', transcript: 'PRIVATE CHAT', token: 'SECRET TOKEN' })
  await until(() => adapters.harness.runs.length === 2)
  assert.equal(adapters.harness.runs[0].session_id, adapters.harness.runs[1].session_id)
  adapters.harness.finish(b.id)
  await until(() => hub.task('master', b.id).status === 'completed' && worker.store.pending().length === 0)
  assert.equal(hub.task('master', a.id).result.answer, 'final')
  assert.equal(JSON.stringify(hub.task('master', a.id).result).includes('SECRET'), false)
  assert.equal(hub.store.all('mailbox').length, 2)
  assert.ok(worker.store.db.prepare('SELECT COUNT(*) AS n FROM receipts').get().n > 0)
})

test('different Harness devices execute concurrently without sharing sessions or results', async (t) => {
  const { hub, endpoint, adapters, dir, config } = await setup(t)
  const device = hub.enroll({ code: hub.createPair('master').code, name: 'second device' })
  const adapter = new FakeAdapter()
  const worker = await new Worker({ dbPath: join(dir, 'second.sqlite'), config: { ...config, ...device }, adapters: { harness: adapter }, localPort: 0 }).start()
  t.after(() => worker.close())
  await until(() => hub.listDevices('master').some(d => d.id === device.device_id && d.endpoints[0]?.ready))
  const a = hub.dispatch('master', { endpoint_id: endpoint, prompt: 'first device' })
  const b = hub.dispatch('master', { endpoint_id: device.device_id + ':harness', prompt: 'second device' })
  await until(() => adapter.runs.length === 1 && adapters.harness.runs.length === 1)
  assert.notEqual(adapter.runs[0].session_id, adapters.harness.runs[0].session_id)
  adapter.finish(b.id, { status: 'completed', answer: 'second' }); adapters.harness.finish(a.id, { status: 'completed', answer: 'first' })
  await until(() => hub.task('master', a.id).status === 'completed' && hub.task('master', b.id).status === 'completed')
  assert.equal(hub.task('master', a.id).result.answer, 'first'); assert.equal(hub.task('master', b.id).result.answer, 'second')
})

test('offline task is rejected without a task or delayed queue; other masters cannot dispatch', async (t) => {
  const { hub, worker, endpoint } = await setup(t)
  assert.throws(() => hub.dispatch('stranger', { endpoint_id: endpoint, prompt: 'x' }), /unknown-endpoint/)
  worker.stopped = true; worker.ws.terminate()
  await until(() => !hub.isOnline(worker.config.device_id))
  assert.throws(() => hub.dispatch('master', { endpoint_id: endpoint, prompt: 'do not execute on reconnect' }), /offline/)
  assert.equal(hub.store.all('tasks').length, 0)
})

test('duplicate dispatch never repeats native execution; lost result acknowledgement resends then saves receipt', async (t) => {
  const { hub, worker, adapters, endpoint } = await setup(t)
  const a = hub.dispatch('master', { endpoint_id: endpoint, prompt: 'once' })
  const dispatch = hub.store.pending().find((m) => m.task_id === a.id)
  await until(() => adapters.harness.runs.length === 1)
  worker.receive(dispatch); worker.receive(dispatch)
  assert.equal(adapters.harness.runs.length, 1)
  const actualSend = hub.connections.get(worker.config.device_id).ws.send.bind(hub.connections.get(worker.config.device_id).ws)
  let dropped = false
  hub.connections.get(worker.config.device_id).ws.send = (raw) => {
    const m = JSON.parse(raw)
    if (!dropped && m.type === 'ack' && hub.task('master', a.id).status === 'completed') { dropped = true; return }
    actualSend(raw)
  }
  adapters.harness.finish(a.id)
  await until(() => hub.task('master', a.id).status === 'completed')
  assert.equal(worker.store.pending().some((m) => m.type === 'task.result'), true)
  worker.flush()
  await until(() => worker.store.pending().length === 0)
  assert.equal(hub.store.all('mailbox').length, 1)
})

test('approval is task-scoped, persists and rejects late or cross-task decisions', async (t) => {
  const { hub, worker, adapters, endpoint } = await setup(t)
  const a = hub.dispatch('master', { endpoint_id: endpoint, prompt: 'approve' })
  await until(() => adapters.harness.runs.length === 1)
  adapters.harness.pending.get(a.id).hooks.interaction({ kind: 'approval', interaction_id: 'ap1', tool_name: 'Bash', arguments: { command: 'test' } })
  await until(() => hub.task('master', a.id).status === 'waiting_approval')
  hub.decision(a.id + ':ap1', 'allowed-once')
  assert.throws(() => hub.decision(a.id + ':ap1', 'rejected'), /interaction-not-pending/)
  await until(() => adapters.harness.lastDecision)
  assert.equal(adapters.harness.lastDecision.answer, 'allowed-once')
  await until(() => hub.store.get('interactions', a.id + ':ap1').resolved)
  assert.throws(() => hub.decision(a.id + ':ap1', 'allowed-once'), /interaction-not-pending/)
  assert.equal(worker.store.get('tasks', a.id).status, 'running')
  adapters.harness.finish(a.id)
  await until(() => hub.task('master', a.id).status === 'completed')
})

test('running task survives network loss and sends result on reconnect without rerun', async (t) => {
  const { hub, worker, adapters, endpoint } = await setup(t)
  const a = hub.dispatch('master', { endpoint_id: endpoint, prompt: 'continue locally' })
  await until(() => hub.task('master', a.id).status === 'running')
  worker.ws.terminate()
  await until(() => !hub.isOnline(worker.config.device_id))
  adapters.harness.finish(a.id)
  await until(() => hub.task('master', a.id).status === 'completed', 8000)
  assert.equal(adapters.harness.runs.length, 1)
})

test('unstarted queued task is interrupted on disconnect', async (t) => {
  const { hub, worker, adapters, endpoint } = await setup(t)
  const a = hub.dispatch('master', { endpoint_id: endpoint, prompt: 'running' })
  await until(() => adapters.harness.runs.length === 1)
  const b = hub.dispatch('master', { endpoint_id: endpoint, prompt: 'queued' })
  await until(() => worker.store.get('tasks', b.id)?.status === 'accepted')
  worker.ws.terminate()
  await until(() => worker.store.get('tasks', b.id)?.status === 'interrupted')
  adapters.harness.finish(a.id)
  await until(() => hub.task('master', b.id).status === 'interrupted', 8000)
  assert.equal(adapters.harness.runs.length, 1)
})

test('SQLite receipts require matching task/attempt/binding and durable acknowledgement', (t) => {
  const dir = temp(t); const path = join(dir, 'ledger.sqlite'); let s = new Store(path)
  const message = frame('task.result', { status: 'failed' }, { task_id: 'a', attempt_id: 'attempt', binding_version: 1 })
  s.enqueue(message)
  for (const changes of [{ task_id: 'other' }, { attempt_id: 'other' }, { binding_version: 2 }, { payload: { ack_id: message.message_id, persisted: false } }]) {
    assert.equal(s.acknowledge({ ...frame('ack', { ack_id: message.message_id, persisted: true }, { task_id: 'a', attempt_id: 'attempt', binding_version: 1 }), ...changes }), false)
  }
  assert.equal(s.pending().length, 1)
  assert.equal(s.acknowledge(frame('ack', { ack_id: message.message_id, persisted: true }, { task_id: 'a', attempt_id: 'attempt', binding_version: 1 })), true)
  s.close(); s = new Store(path)
  assert.equal(s.pending().length, 0); assert.equal(s.receipt('ack:' + message.message_id).payload.persisted, true)
  s.close()
})

test('unauthorized websocket rejected and pairing codes are one-use', async (t) => {
  const { hub, config } = await setup(t)
  const pair = hub.createPair('master'); hub.enroll({ code: pair.code, name: 'once' })
  assert.throws(() => hub.enroll({ code: pair.code, name: 'twice' }), /invalid-pair-code/)
  const url = new URL('/v2/worker?device_id=' + config.device_id, config.hub); url.protocol = 'ws:'
  await new Promise((resolve) => { const ws = new WebSocket(url, { headers: { Authorization: 'Bearer wrong' } }); ws.on('error', (e) => { assert.match(e.message, /401/); resolve() }) })
})
