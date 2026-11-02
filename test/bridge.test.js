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
import { temp, until, FakeHarnessContext, autoReply } from './helpers.js'

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
