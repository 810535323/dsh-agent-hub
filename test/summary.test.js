import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { Hub } from '../src/hub.js'
import { MasterCoordinator } from '../src/master.js'
import { noticeId } from '../src/reports.js'
import { temp, until, FakeHarnessContext } from './helpers.js'

function fixture(t, busy = false) {
  const hub = new Hub({ dbPath: join(temp(t), 'hub.sqlite'), adminToken: 'test' })
  const ctx = new FakeHarnessContext(); ctx.makeSession('main')
  ctx.agents.get('main').status = busy ? 'running' : 'idle'
  const sent = []
  ctx.dshIm = { send: async (...args) => { sent.push(args); return { sent: true } } }
  hub.bindMaster({ session_id: 'main', bot_id: 'wx', target_id: 'user' })
  const task = { id: 'task-one', master_id: 'main', device_id: 'worker', status: 'completed', result_message_id: 'result-one', result: { status: 'completed', answer: '从机原始最终答复', raw_output: 'NEVER SEND', transcript: 'NEVER SEND' } }
  hub.store.put('tasks', task)
  const coordinator = new MasterCoordinator(ctx, hub)
  t.after(() => { coordinator.close(); hub.store.close() })
  return { hub, ctx, task, coordinator, sent }
}
function finish(ctx, turn, answer, message = ctx.submitted.message) {
  ctx.event('main', 'turn/start', { turn })
  ctx.event('main', 'user/message', { turn, id: message.id, source: message.source, content: message.content })
  ctx.event('main', 'assistant/message', { turn, step: 0, message: { content: [{ type: 'text', text: answer }] } })
  ctx.event('main', 'turn/end', { turn, reason: 'completed' })
}

test('busy main queues results without a WeChat push; only its exact completed summary is delivered once', async t => {
  const { hub, ctx, task, coordinator, sent } = fixture(t, true)
  coordinator.tick(); await new Promise(r => setImmediate(r))
  assert.equal(sent.length, 0, 'worker final answer must not be sent before the main AI summarizes it')
  assert.equal(ctx.submitted, undefined)
  assert.equal(coordinator.pendingReports('main').length, 1)
  ctx.agents.get('main').status = 'idle'; coordinator.tick()
  await until(() => ctx.submitted)
  assert.equal(sent.length, 0)
  assert.equal(ctx.submitted.message.content[0].text.includes('NEVER SEND'), false)
  finish(ctx, 9, '与远程任务无关的回复', { id: 'unrelated', source: { kind: 'user' }, content: [{ type: 'text', text: 'other turn' }] })
  await new Promise(r => setImmediate(r)); assert.equal(sent.length, 0)
  finish(ctx, 10, '主机 AI 总结：任务已核验完成。')
  await until(() => sent.length === 1)
  assert.match(sent[0][2], /主机 AI 总结/)
  assert.equal(sent[0][2].includes('从机原始最终答复'), false)
  coordinator.tick(); await new Promise(r => setImmediate(r))
  assert.equal(sent.length, 1)
  assert.equal(coordinator.pendingReports('main').length, 0)
  assert.equal(hub.store.all('delivery_receipts').length, 1)
  assert.equal(hub.store.get('notifications', noticeId(task)).state, 'sent')
})

test('main summary final answer is persisted before delivery; restart retries delivery without another AI turn', async t => {
  const { hub, ctx, task, coordinator, sent } = fixture(t)
  let attempts = 0
  ctx.dshIm.send = async (...args) => {
    attempts++
    if (attempts === 1) throw Object.assign(Error('offline'), { code: 'bot-not-connected' })
    sent.push(args); return { sent: true }
  }
  coordinator.tick(); await until(() => ctx.submitted)
  finish(ctx, 10, '已保存的主机总结')
  await until(() => hub.store.get('notifications', noticeId(task))?.state === 'failed')
  const originalMessage = ctx.submitted.message.id
  coordinator.close()
  const restarted = new MasterCoordinator(ctx, hub); t.after(() => restarted.close())
  const n = hub.store.get('notifications', noticeId(task))
  assert.match(n.text, /已保存的主机总结/)
  hub.store.put('notifications', { ...n, retry_at: 0 })
  restarted.tick(); await until(() => sent.length === 1)
  assert.equal(ctx.submitted.message.id, originalMessage)
  assert.equal(attempts, 2)
})

test('main AI failure leaves a visible pending report and never falls back to sending the worker answer', async t => {
  const { hub, ctx, task, coordinator, sent } = fixture(t)
  coordinator.tick(); await until(() => ctx.submitted)
  ctx.event('main', 'turn/start', { turn: 10 })
  ctx.event('main', 'user/message', { turn: 10, id: ctx.submitted.message.id, source: ctx.submitted.message.source, content: ctx.submitted.message.content })
  ctx.event('main', 'turn/end', { turn: 10, reason: 'error' })
  await until(() => hub.store.get('notifications', noticeId(task))?.state === 'needs_attention')
  coordinator.tick(); await new Promise(r => setImmediate(r))
  assert.equal(sent.length, 0)
  assert.equal(coordinator.pendingReports('main').length, 1)
})

test('upgrade stops an unsent raw completion notice and preserves already sent or uncertain deliveries', async t => {
  const { hub, task, coordinator, sent } = fixture(t, true)
  hub.store.put('notifications', { id: noticeId(task), task_id: task.id, revision: 'result-one', kind: 'task-status', master_id: 'main', bot_id: 'wx', target_id: 'user', text: '旧的原文通知', state: 'pending', tries: 0 })
  coordinator.tick(); await new Promise(r => setImmediate(r))
  assert.equal(sent.length, 0)
  assert.equal(hub.store.get('notifications', noticeId(task)).state, 'awaiting_summary')
  for (const state of ['sent', 'unknown']) {
    hub.store.put('notifications', { ...hub.store.get('notifications', noticeId(task)), state })
    coordinator.tick(); await new Promise(r => setImmediate(r))
    assert.equal(hub.store.get('notifications', noticeId(task)).state, state)
    assert.equal(sent.length, 0)
  }
})

test('a newer result supersedes a saved but unsent summary rather than retrying stale conclusions', async t => {
  const { hub, ctx, task, coordinator, sent } = fixture(t)
  ctx.dshIm.send = async () => { throw Object.assign(Error('offline'), { code: 'bot-not-connected' }) }
  coordinator.tick(); await until(() => ctx.submitted)
  const oldMessage = ctx.submitted.message.id
  finish(ctx, 10, '旧的总结结论')
  await until(() => hub.store.get('notifications', noticeId(task))?.state === 'failed')
  ctx.dshIm.send = async (...args) => { sent.push(args); return { sent: true } }
  hub.store.put('notifications', { ...hub.store.get('notifications', noticeId(task)), retry_at: 0 })
  hub.store.put('tasks', { ...task, result_message_id: 'new-result', result: { status: 'completed', answer: '新的证据' } })
  coordinator.tick(); await until(() => ctx.submitted.message.id !== oldMessage)
  assert.equal(sent.length, 0)
  finish(ctx, 11, '更新后的主机总结')
  await until(() => sent.length === 1)
  assert.match(sent[0][2], /更新后的主机总结/)
  assert.equal(hub.store.get('notifications', noticeId(task)).state, 'superseded')
})

test('a completed native summary is reconciled after restart without repeating the AI turn', async t => {
  const { hub, ctx, task, coordinator, sent } = fixture(t)
  coordinator.tick(); await until(() => ctx.submitted)
  const originalMessage = ctx.submitted.message
  ctx.event('main', 'turn/start', { turn: 10 })
  ctx.event('main', 'user/message', { turn: 10, id: originalMessage.id, source: originalMessage.source, content: originalMessage.content })
  coordinator.close()
  ctx.event('main', 'assistant/message', { turn: 10, message: { content: [{ type: 'text', text: '崩溃边界后的可恢复总结' }] } })
  ctx.event('main', 'turn/end', { turn: 10, reason: 'completed' })
  const restarted = new MasterCoordinator(ctx, hub); t.after(() => restarted.close())
  restarted.tick(); await until(() => sent.length === 1)
  assert.match(sent[0][2], /可恢复总结/)
  assert.equal(ctx.submitted.message.id, originalMessage.id)
  assert.equal(hub.store.all('report_consumption').length, 1)
  assert.equal(hub.store.get('notifications', noticeId(task)).state, 'sent')
})

test('failed summary persistence is retried from native evidence without an early WeChat push', async t => {
  const { hub, ctx, task, coordinator, sent } = fixture(t)
  hub.store.db.exec("CREATE TRIGGER fail_summary BEFORE INSERT ON records WHEN NEW.bucket='report_consumption' BEGIN SELECT RAISE(ABORT, 'storage failure'); END")
  coordinator.tick(); await until(() => ctx.submitted)
  const messageId = ctx.submitted.message.id
  finish(ctx, 10, '事务恢复总结')
  await until(() => !coordinator.busy.has('main'))
  assert.equal(sent.length, 0)
  assert.equal(hub.store.get('notifications', noticeId(task)).state, 'summarizing')
  hub.store.db.exec('DROP TRIGGER fail_summary')
  coordinator.tick(); await until(() => sent.length === 1)
  assert.equal(ctx.submitted.message.id, messageId)
  assert.match(sent[0][2], /事务恢复总结/)
})

test('an exhausted legacy raw notice gets a fresh summary delivery budget without reusing old receipt numbers', async t => {
  const { hub, ctx, task, coordinator, sent } = fixture(t)
  hub.store.put('notifications', { id: noticeId(task), task_id: task.id, revision: 'result-one', kind: 'task-status', master_id: 'main', bot_id: 'wx', target_id: 'user', text: '旧原文', state: 'failed', tries: 3 })
  coordinator.tick(); await until(() => ctx.submitted)
  finish(ctx, 10, '升级后的主机总结')
  await until(() => !coordinator.busy.has('main'))
  assert.equal(sent.length, 1)
  assert.match(sent[0][2], /升级后的主机总结/)
  assert.equal(hub.store.get('notifications', noticeId(task)).tries, 1)
  assert.match(hub.store.all('delivery_receipts')[0].id, /:4$/)
})

test('a landed but unfinished summary on an idle Session is flagged without starving subsequent reports', async t => {
  const { hub, ctx, task, coordinator, sent } = fixture(t)
  coordinator.tick(); await until(() => ctx.submitted)
  const message = ctx.submitted.message
  ctx.event('main', 'turn/start', { turn: 10 })
  ctx.event('main', 'user/message', { turn: 10, id: message.id, source: message.source, content: message.content })
  coordinator.close()
  const restarted = new MasterCoordinator(ctx, hub); t.after(() => restarted.close())
  restarted.tick(); await until(() => !restarted.busy.has('main'))
  assert.equal(hub.store.get('notifications', noticeId(task)).state, 'needs_attention')
  hub.store.put('tasks', { ...task, id: 'next-task', result_message_id: 'next-result' })
  restarted.tick(); await until(() => ctx.submitted.message.id !== message.id)
  finish(ctx, 11, '后续任务的主机总结')
  await until(() => sent.length === 1)
  assert.match(sent[0][2], /next-task/)
  assert.equal(restarted.pendingReports('main').length, 1)
})

test('recovery rechecks completion after the Session becomes idle instead of losing a concurrently finished summary', async t => {
  const { ctx, coordinator, hub, task, sent } = fixture(t)
  coordinator.tick(); await until(() => ctx.submitted)
  const message = ctx.submitted.message
  ctx.event('main', 'turn/start', { turn: 10 })
  ctx.event('main', 'user/message', { turn: 10, id: message.id, source: message.source, content: message.content })
  coordinator.close()
  const restarted = new MasterCoordinator(ctx, hub); t.after(() => restarted.close())
  const reconcile = restarted.native.reconcile.bind(restarted.native)
  let finishDuringRecovery = true
  restarted.native.reconcile = async callback => {
    const result = await reconcile(callback)
    if (finishDuringRecovery) {
      finishDuringRecovery = false
      ctx.event('main', 'assistant/message', { turn: 10, message: { content: [{ type: 'text', text: '核对期间刚刚结束的总结' }] } })
      ctx.event('main', 'turn/end', { turn: 10, reason: 'completed' })
    }
    return result
  }
  restarted.tick(); await until(() => !restarted.busy.has('main'))
  assert.equal(sent.length, 1)
  assert.match(sent[0][2], /核对期间刚刚结束的总结/)
  assert.equal(hub.store.get('notifications', noticeId(task)).state, 'sent')
})
