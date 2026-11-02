import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { Hub } from '../src/hub.js'
import { MasterCoordinator } from '../src/master.js'
import { noticeId, reportRevision } from '../src/reports.js'
import { temp, until, FakeHarnessContext, autoReply } from './helpers.js'

function fixture(t, { busy = false, native, send } = {}) {
  const path = join(temp(t), 'hub.sqlite'), hub = new Hub({ dbPath: path, adminToken: 'test' })
  const ctx = new FakeHarnessContext(); autoReply(ctx, '主 Agent 的核验总结')
  ctx.makeSession('main'); ctx.agents.get('main').status = busy ? 'running' : 'idle'
  const sent = []
  ctx.dshIm = { send: send || (async (...args) => { sent.push(args); return { sent: true } }) }
  hub.bindMaster({ session_id: 'main', bot_id: 'wx', target_id: 'user' })
  const task = { id: 'task-one', master_id: 'main', device_id: 'worker', attempt_id: 'attempt', status: 'completed', finished_at: '2026-10-23T06:07:37.910Z', result_message_id: 'result-one', result: { status: 'completed', answer: '本任务的最终答复', verification: ['test passed'] } }
  hub.store.put('tasks', task)
  hub.store.put('mailbox', { id: task.id, task_id: task.id, master_id: 'main', state: 'pending', revision: reportRevision(task) })
  const coordinator = new MasterCoordinator(ctx, hub, native ? { native } : {})
  t.after(() => { coordinator.close(); hub.store.close() })
  return { hub, ctx, coordinator, task, sent, path }
}

test('manual report acknowledgement is scoped and idempotent, and cannot bypass main-AI summarization', async t => {
  const { hub, ctx, coordinator, task, sent } = fixture(t, { busy: true })
  coordinator.tick(); await new Promise(r => setImmediate(r))
  const report = coordinator.pendingReports('main')[0]
  assert.equal(report.delivery, 'awaiting_summary'); assert.equal(coordinator.pendingReports('stranger').length, 0)
  assert.throws(() => coordinator.acknowledgeReports('stranger', [report]), /unknown-report/)
  assert.throws(() => coordinator.acknowledgeReports('main', [{ ...report, revision: 'old' }]), /stale-report/)
  coordinator.acknowledgeReports('main', [report]); coordinator.acknowledgeReports('main', [report])
  assert.equal(coordinator.pendingReports('main').length, 0)
  assert.equal(sent.length, 0)
  ctx.agents.get('main').status = 'idle'; coordinator.tick()
  await until(() => hub.store.get('notifications', noticeId(task))?.state === 'sent')
  assert.equal(sent.length, 1); assert.match(sent[0][2], /主 Agent 的核验总结/)
  assert.equal(hub.store.all('report_consumption').length, 1)
})

test('unavailable main keeps the durable result queued, with no raw notification fallback', async t => {
  const native = { isIdle: async () => { throw Error('main unavailable') }, close() {} }
  const { hub, coordinator, task, sent } = fixture(t, { native })
  hub.store.remove('mailbox', task.id)
  coordinator.tick(); await new Promise(r => setImmediate(r))
  assert.equal(sent.length, 0)
  assert.equal(hub.store.get('notifications', noticeId(task)).state, 'awaiting_summary')
  assert.equal(coordinator.reportStatus().pending_count, 1)
})

test('legacy ambiguous delivery remains queryable and is never blindly resent or summarized again', async t => {
  const { hub, coordinator, task, sent } = fixture(t)
  hub.store.put('notifications', { id: task.id, master_id: 'main', text: 'old summary', state: 'unknown', tries: 1 })
  coordinator.tick(); await new Promise(r => setImmediate(r))
  assert.equal(sent.length, 0)
  assert.equal(hub.store.get('notifications', noticeId(task)).state, 'unknown')
  assert.equal(coordinator.pendingReports('main').length, 1)
})

test('summary delivery retries explicit failure but retains ambiguous results across coordinator restart', async t => {
  let calls = 0
  const { hub, ctx, coordinator, task } = fixture(t, { send: async () => { calls++; throw Object.assign(Error(), { code: calls === 1 ? 'bot-not-connected' : 'send-result-unknown' }) } })
  coordinator.tick(); await until(() => hub.store.get('notifications', noticeId(task))?.state === 'failed')
  assert.equal(calls, 1); coordinator.tick(); await new Promise(r => setImmediate(r)); assert.equal(calls, 1)
  const n = hub.store.get('notifications', noticeId(task)); hub.store.put('notifications', { ...n, retry_at: 0 })
  coordinator.tick(); await until(() => hub.store.get('notifications', noticeId(task)).state === 'unknown')
  coordinator.close()
  const recovered = new MasterCoordinator(ctx, hub); t.after(() => recovered.close())
  recovered.tick(); await new Promise(r => setImmediate(r)); assert.equal(calls, 2)
  assert.equal(hub.store.get('notifications', noticeId(task)).state, 'unknown')
  assert.equal(coordinator.pendingReports('main').length, 0)
  assert.equal(recovered.reportStatus().delivery_issues[0].state, 'unknown')
})

test('new result revision remains unread even when an earlier state was consumed', async t => {
  const { hub, coordinator, task } = fixture(t, { busy: true })
  coordinator.acknowledgeReports('main', coordinator.pendingReports('main'))
  hub.store.put('tasks', { ...task, result_message_id: 'new-result', result: { status: 'completed', answer: 'new evidence' } })
  const report = coordinator.pendingReports('main')[0]
  assert.equal(report.revision, 'new-result')
  assert.throws(() => coordinator.acknowledgeReports('main', [{ report_id: task.id, revision: 'result-one' }]), /stale-report/)
  assert.equal(coordinator.reportStatus().pending_count, 1)
})

test('a changed WeChat binding pauses the summary instead of sending it to another user', async t => {
  const { hub, coordinator, task, sent } = fixture(t)
  coordinator.repairBacklog()
  hub.store.put('masters', { ...hub.store.get('masters', 'main'), target_id: 'another-user' })
  coordinator.tick(); await new Promise(r => setImmediate(r))
  assert.equal(sent.length, 0); assert.equal(hub.store.get('notifications', noticeId(task)).state, 'blocked')
})

test('unread results survive a SQLite restart and are summarized once after the main Session becomes idle', async t => {
  const path = join(temp(t), 'restart.sqlite'), ctx = new FakeHarnessContext()
  autoReply(ctx, '重启后主机总结'); ctx.makeSession('main'); ctx.agents.get('main').status = 'running'
  const sent = []; ctx.dshIm = { send: async (...args) => { sent.push(args); return { sent: true } } }
  let hub = new Hub({ dbPath: path, adminToken: 'test' }), coordinator
  const task = { id: 'restart-task', master_id: 'main', device_id: 'worker', status: 'completed', result_message_id: 'persisted-revision', result: { status: 'completed', answer: 'durable final' } }
  try {
    hub.bindMaster({ session_id: 'main', bot_id: 'wx', target_id: 'user' }); hub.store.put('tasks', task)
    coordinator = new MasterCoordinator(ctx, hub); coordinator.tick(); await new Promise(r => setImmediate(r))
    assert.equal(sent.length, 0)
    coordinator.close(); hub.store.close(); hub = new Hub({ dbPath: path, adminToken: 'test' })
    coordinator = new MasterCoordinator(ctx, hub)
    assert.equal(coordinator.pendingReports('main').length, 1)
    ctx.agents.get('main').status = 'idle'; coordinator.tick()
    await until(() => hub.store.get('notifications', noticeId(task))?.state === 'sent')
    coordinator.tick(); await new Promise(r => setImmediate(r))
    assert.equal(sent.length, 1); assert.match(sent[0][2], /重启后主机总结/)
    assert.equal(hub.store.all('delivery_receipts').length, 1)
  } finally { coordinator?.close(); hub.store.close() }
})
