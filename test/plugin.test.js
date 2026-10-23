import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { startHub } from '../src/plugin.js'
import { FakeHarnessContext, temp } from './helpers.js'

test('main tools bind using only the public DSH-IM facade, scope callers, and do not send a message during pairing', async (t) => {
  const dir = temp(t); const ctx = new FakeHarnessContext(); const main = ctx.makeSession('main'); const tools = new Map()
  ctx.tools = { register: (definition) => { tools.set(definition.name, definition) } }
  ctx.inject = (dependencies, activate) => { if (dependencies.every((d) => ctx[d])) return activate(ctx) }
  let sent = 0
  ctx.dshIm = {
    listBots: async () => [{ botId: 'wx', channel: 'weixin' }],
    listTargets: async () => [{ targetId: 'person', kind: 'user', sessionSync: { enabled: true } }],
    send: async () => { sent++; return { sent: true } },
  }
  const { hub, coordinator } = await startHub(ctx, { dataDir: dir, port: 0 })
  try {
    const paired = await tools.get('agent_hub_pair').execute({}, { agent: ctx.agents.get(main.id) })
    assert.equal(paired.code.length, 12); assert.equal(sent, 0)
    assert.deepEqual(hub.store.get('masters', 'main'), { id: 'main', session_id: 'main', bot_id: 'wx', target_id: 'person' })
    await assert.rejects(tools.get('agent_hub_devices').execute({}, { agent: { id: 'other' } }), /master-not-bound/)
    assert.equal(tools.has('agent_hub_review_approval'), true)
    hub.store.put('tasks', { id: 'finished', master_id: main.id, status: 'completed', result_message_id: 'revision', result: { status: 'completed', answer: 'final' } })
    coordinator.repairBacklog()
    const exec = { agent: ctx.agents.get(main.id) }
    const pending = await tools.get('agent_hub_pending_reports').execute({}, exec)
    assert.equal(pending.reports[0].task_id, 'finished')
    await assert.rejects(tools.get('agent_hub_ack_reports').execute({ reports: [{ report_id: 'finished', revision: 'old' }] }, exec), /stale-report/)
    const state = await tools.get('agent_hub_task').execute({ task_id: 'finished' }, exec)
    assert.equal(state.delivery.kind, 'task-status')
    await tools.get('agent_hub_ack_reports').execute({ reports: pending.reports.map(({ report_id, revision }) => ({ report_id, revision })) }, exec)
    assert.equal((await tools.get('agent_hub_pending_reports').execute({}, exec)).reports.length, 0)
    assert.equal(sent, 0)
  } finally { coordinator.close(); await hub.close() }
})
