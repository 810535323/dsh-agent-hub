import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { Hub } from '../src/hub.js'
import { MasterCoordinator } from '../src/master.js'
import { noticeId, reportRevision } from '../src/reports.js'
import { temp, until, FakeHarnessContext } from './helpers.js'

function fixture(t, { busy = false, native, send } = {}) {
  const dir = temp(t), path = join(dir, 'hub.sqlite'), hub = new Hub({ dbPath: path, adminToken: 'test' })
  const ctx = new FakeHarnessContext(), agent = ctx.makeSession('main')
  ctx.agents.get(agent.id).status = busy ? 'running' : 'idle'
  const sent = []
  ctx.dshIm = { send: send || (async (...args) => { sent.push(args); return { sent: true } }) }
  hub.bindMaster({ session_id: 'main', bot_id: 'wx', target_id: 'user' })
  const task = { id: 'task-one', master_id: 'main', device_id: 'worker', attempt_id: 'attempt', status: 'completed', finished_at: '2026-10-23T06:07:37.910Z', result_message_id: 'result-one', result: { status: 'completed', answer: '本任务的最终答复', verification: ['test passed'], raw_output: 'NEVER SEND', transcript: 'NEVER SEND' } }
  hub.store.put('tasks', task); hub.store.put('mailbox', { id: task.id, task_id: task.id, master_id: 'main', state: 'pending', revision: reportRevision(task) })
  const coordinator = new MasterCoordinator(ctx, hub, native ? { native } : {})
  t.after(() => { coordinator.close(); hub.store.close() })
  return { hub, ctx, coordinator, task, sent, path }
}

test('busy main cannot delay direct completion notice; durable result stays unread until explicit consumption', async t => {
  const { hub, ctx, coordinator, task, sent } = fixture(t, { busy: true })
  coordinator.tick()
  await until(() => hub.store.get('notifications', noticeId(task))?.state === 'sent')
  assert.equal(ctx.submitted, undefined)
  assert.equal(sent.length, 1); assert.match(sent[0][2], /task-one/); assert.match(sent[0][2], /本任务的最终答复/)
  assert.equal(sent[0][2].includes('NEVER SEND'), false)
  assert.equal(hub.store.all('delivery_receipts').length, 1)
  assert.equal(hub.store.get('mailbox', task.id).state, 'pending')
  const report = coordinator.pendingReports('main')[0]
  assert.equal(report.delivery, 'sent'); assert.equal(coordinator.pendingReports('stranger').length, 0)
  assert.throws(() => coordinator.acknowledgeReports('stranger', [report]), /unknown-report/)
  assert.throws(() => coordinator.acknowledgeReports('main', [{ ...report, revision: 'old' }]), /stale-report/)
  coordinator.acknowledgeReports('main', [report]); coordinator.acknowledgeReports('main', [report])
  assert.equal(coordinator.pendingReports('main').length, 0)
  assert.equal(hub.store.all('report_consumption').length, 1)
  assert.equal(hub.store.get('notifications', noticeId(task)).state, 'sent')
})

test('idle transition enqueues only a queue reminder, never waits for an Agent turn or treats another response as acknowledgement', async t => {
  const { hub, ctx, coordinator, task } = fixture(t, { busy: true })
  coordinator.tick(); await until(() => hub.store.get('notifications', noticeId(task))?.state === 'sent')
  ctx.agents.get('main').status = 'idle'; ctx.emit('agent/status', { agent: ctx.agents.get('main'), status: 'idle' })
  await until(() => ctx.submitted)
  assert.equal(ctx.submitted.id, 'main'); assert.match(ctx.submitted.message.content[0].text, /agent_hub_pending_reports/)
  ctx.event('main', 'assistant/message', { turn: 99, message: { content: [{ type: 'text', text: 'QMT 用不了' }] } })
  ctx.event('main', 'turn/end', { turn: 99, reason: 'completed' })
  assert.equal(coordinator.pendingReports('main').length, 1)
  assert.equal(hub.store.get('mailbox', task.id).state, 'pending')
  assert.equal(coordinator.native.active.size, 0)
  assert.ok(hub.store.get('report_wakeups', 'main').message_id)
})

test('main unavailable does not block notification; a missing mailbox is reconstructed from the durable task', async t => {
  const native = { isIdle: async () => { throw Error('main unavailable') }, enqueue() { throw Error('unreachable') }, close() {} }
  const { hub, coordinator, task } = fixture(t, { native })
  hub.store.remove('mailbox', task.id)
  coordinator.tick()
  await until(() => hub.store.get('notifications', noticeId(task))?.state === 'sent')
  assert.equal(coordinator.reportStatus().pending_count, 1)
  assert.equal(coordinator.pendingReports('main')[0].task_id, task.id)
})

test('legacy pending result is independently delivered; old sent or uncertain notifications are not blindly resent', async t => {
  const { hub, coordinator, task, sent } = fixture(t, { busy: true })
  hub.store.put('notifications', { id: task.id, master_id: 'main', text: 'old summary', state: 'unknown', tries: 1 })
  coordinator.tick(); await new Promise(r => setImmediate(r))
  assert.equal(sent.length, 0)
  assert.equal(hub.store.get('notifications', noticeId(task)).state, 'unknown')
  assert.equal(coordinator.pendingReports('main').length, 1)
})

test('explicit failure is retried; uncertain delivery survives restart and never retries automatically', async t => {
  let calls = 0
  const { hub, ctx, coordinator, task } = fixture(t, { busy: true, send: async () => { calls++; throw Object.assign(Error(), { code: calls === 1 ? 'bot-not-connected' : 'send-result-unknown' }) } })
  coordinator.tick(); await until(() => hub.store.get('notifications', noticeId(task))?.state === 'failed')
  assert.equal(calls, 1); coordinator.tick(); await new Promise(r => setImmediate(r)); assert.equal(calls, 1)
  const n = hub.store.get('notifications', noticeId(task)); hub.store.put('notifications', { ...n, retry_at: 0 })
  coordinator.tick(); await until(() => hub.store.get('notifications', noticeId(task)).state === 'unknown')
  coordinator.close()
  const recovered = new MasterCoordinator(ctx, hub); t.after(() => recovered.close())
  recovered.tick(); await new Promise(r => setImmediate(r)); assert.equal(calls, 2)
  assert.equal(hub.store.get('notifications', noticeId(task)).state, 'unknown')
  recovered.close()
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

test('a changed WeChat binding pauses delivery instead of redirecting an old task notice', async t => {
  const { hub, coordinator, task, sent } = fixture(t, { busy: true })
  coordinator.repairBacklog()
  hub.store.put('masters', { ...hub.store.get('masters', 'main'), target_id: 'another-user' })
  await coordinator.deliver(noticeId(task))
  assert.equal(sent.length, 0); assert.equal(hub.store.get('notifications', noticeId(task)).state, 'blocked')
})

test('exhausted delivery and a hung callback cannot starve other results', async t => {
  const { hub, coordinator, task, sent } = fixture(t, { busy: true })
  hub.store.put('notifications', { id: 'interaction:old', master_id: 'main', text: 'old failure', state: 'failed', tries: 3 })
  coordinator.busy.add('main')
  coordinator.tick(); await until(() => hub.store.get('notifications', noticeId(task))?.state === 'sent')
  assert.equal(sent.length, 1); assert.equal(coordinator.pendingReports('main').length, 1)
})

test('unread result and confirmed delivery survive closing and reopening the SQLite-backed Hub', async t => {
  const path = join(temp(t), 'restart.sqlite'), ctx = new FakeHarnessContext()
  ctx.makeSession('main'); ctx.agents.get('main').status = 'running'
  let sends = 0, hub = new Hub({ dbPath: path, adminToken: 'test' }), coordinator
  ctx.dshIm = { send: async () => { sends++; return { sent: true } } }
  const task = { id: 'restart-task', master_id: 'main', device_id: 'worker', status: 'completed', result_message_id: 'persisted-revision', result: { status: 'completed', answer: 'durable final' } }
  try {
    hub.bindMaster({ session_id: 'main', bot_id: 'wx', target_id: 'user' }); hub.store.put('tasks', task)
    coordinator = new MasterCoordinator(ctx, hub); coordinator.tick()
    await until(() => hub.store.get('notifications', noticeId(task))?.state === 'sent')
    coordinator.close(); hub.store.close(); hub = new Hub({ dbPath: path, adminToken: 'test' })
    coordinator = new MasterCoordinator(ctx, hub); coordinator.tick(); await new Promise(r => setImmediate(r))
    assert.equal(sends, 1); assert.equal(coordinator.pendingReports('main').length, 1)
    assert.equal(hub.store.all('delivery_receipts').length, 1)
    coordinator.acknowledgeReports('main', coordinator.pendingReports('main'))
    assert.equal(hub.store.all('report_consumption').length, 1)
  } finally { coordinator?.close(); hub.store.close() }
})
