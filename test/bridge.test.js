import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { Hub } from '../src/hub.js'
import { Worker } from '../src/worker.js'
import { MasterCoordinator } from '../src/master.js'
import { HarnessBridge } from '../src/adapters/harness-bridge.js'
import { apply as applyHarness } from '../src/harness-plugin.js'
import { noticeId } from '../src/reports.js'
import { writeConfig } from '../src/util.js'
import { temp, until, FakeHarnessContext, FakeAdapter, autoReply } from './helpers.js'

test('full Harness route: Worker result -> main-Agent summary -> one WeChat report with durable receipt', async (t) => {
  const dir = temp(t); const hub = await new Hub({ dbPath: join(dir, 'hub.sqlite'), adminToken: 'x', port: 0 }).listen()
  const mainCtx = new FakeHarnessContext(); autoReply(mainCtx, '主 Agent 最终汇报')
  const main = mainCtx.makeSession('main'); const sent = []
  mainCtx.dshIm = { send: async (...args) => { sent.push(args); return { sent: true } } }
  hub.bindMaster({ session_id: main.id, bot_id: 'wx', target_id: 'person' })
  const coordinator = new MasterCoordinator(mainCtx, hub)
  const device = hub.enroll({ code: hub.createPair('main').code, name: 'Harness device' })
  const bridge = new HarnessBridge()
  const config = { hub: 'http://127.0.0.1:' + hub.server.address().port, ...device, local_token: 'PRIVATE LOCAL KEY', cwd: dir, runtimes: ['harness'] }
  const worker = await new Worker({ dbPath: join(dir, 'worker.sqlite'), config, adapters: { harness: bridge }, localPort: 0 }).start()
  const slaveCtx = new FakeHarnessContext(); autoReply(slaveCtx, '从机最终答复')
  writeConfig(join(dir, 'config.json'), { ...config, local_port: worker.server.address().port })
  applyHarness(slaveCtx, { workerHome: dir, autoStart: false })
  try {
    await until(() => hub.listDevices('main')[0]?.endpoints[0]?.ready)
    const task = hub.dispatch('main', { endpoint_id: device.device_id + ':harness', prompt: '执行任务' })
    await until(() => hub.store.get('notifications', noticeId(hub.store.get('tasks', task.id)))?.state === 'sent')
    assert.equal(hub.task('main', task.id).result.answer, '从机最终答复')
    assert.equal(sent.length, 1); assert.equal(sent[0][0], 'wx'); assert.equal(sent[0][1], 'person'); assert.match(sent[0][2], /主 Agent 最终汇报/)
    assert.equal(sent[0][2].includes('从机最终答复'), false)
    assert.equal(hub.store.get('mailbox', task.id).state, 'consumed')
    assert.equal(hub.store.all('delivery_receipts').length, 1)
  } finally {
    coordinator.close(); for (const d of slaveCtx.disposers) await d(); await worker.close(); await hub.close()
  }
})

test('Codex discovery and exact-session continuation traverse the existing Worker protocol and yield one final WeChat summary', async t => {
  const dir = temp(t), hub = await new Hub({ dbPath: join(dir, 'hub.sqlite'), adminToken: 'test', port: 0 }).listen()
  const ctx = new FakeHarnessContext(); autoReply(ctx, '主机总结：已在选定 Codex 对话中续写完成')
  ctx.makeSession('main'); const sent = []
  ctx.dshIm = { send: async (...args) => { sent.push(args); return { sent: true } } }
  hub.bindMaster({ session_id: 'main', bot_id: 'wx', target_id: 'user' })
  const coordinator = new MasterCoordinator(ctx, hub)
  const device = hub.enroll({ code: hub.createPair('main').code, name: 'Worker' })
  const adapter = new FakeAdapter()
  const worker = await new Worker({ dbPath: join(dir, 'worker.sqlite'), config: { ...device, hub: 'http://127.0.0.1:' + hub.server.address().port, local_token: 'fake-local', cwd: dir, runtimes: ['harness'] }, adapters: { harness: adapter }, localPort: 0 }).start()
  try {
    await until(() => hub.listDevices('main')[0]?.endpoints[0]?.ready)
    const search = hub.dispatch('main', { endpoint_id: device.device_id + ':harness', prompt: '继续之前 Codex alpha 任务', codex: { project_path: 'D:/projects/alpha' } })
    await until(() => adapter.runs.length === 1)
    adapter.finish(search.id, { status: 'completed', answer: JSON.stringify({ codex_session_search: { available: true, candidates: [{ session_id: 'native-codex-session', title: 'alpha', cwd: 'D:/projects/alpha', state: 'idle' }] } }) })
    await until(() => adapter.runs.length === 2)
    assert.equal(sent.length, 0)
    const child = hub.store.get('tasks', adapter.runs[1].id)
    assert.equal(child.codex_call.session_id, 'native-codex-session')
    adapter.finish(child.id, { status: 'completed', answer: JSON.stringify({ answer: '续写完成', codex_session: { session_id: 'native-codex-session', cwd: 'D:/projects/alpha', state: 'idle' }, verification: ['passed'] }) })
    await until(() => hub.store.get('notifications', noticeId(hub.store.get('tasks', child.id)))?.state === 'sent')
    assert.equal(sent.length, 1); assert.match(sent[0][2], /主机总结/)
    assert.equal(hub.store.all('notifications').some(n => n.task_id === search.id), false)
    assert.equal(hub.task('main', search.id).codex_resolution.task_id, child.id)
    assert.equal(hub.store.all('codex_sessions')[0].session_id, 'native-codex-session')
    await until(() => worker.store.pending().length === 0)
  } finally { coordinator.close(); await worker.close(); await hub.close() }
})
