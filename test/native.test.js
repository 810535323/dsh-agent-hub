import test from 'node:test'
import assert from 'node:assert/strict'
import { HarnessHost } from '../src/harness-host.js'
import { MasterCoordinator } from '../src/master.js'
import { Hub } from '../src/hub.js'
import { FakeHarnessContext, temp, until } from './helpers.js'
import { join } from 'node:path'

test('Harness fixed-session ensure replaces only confirmed missing sessions', async () => {
  const ctx = new FakeHarnessContext(); const native = new HarnessHost(ctx)
  try {
    const first = await native.ensure(null, 'C:/workspace')
    assert.equal((await native.ensure(first, 'C:/workspace')).session_id, first.session_id)
    ctx.sessionController.inspect = async () => { throw Object.assign(new Error('auth denied'), { code: 'auth-error' }) }
    await assert.rejects(native.ensure(first, 'C:/workspace'), /auth denied/)
    assert.equal(ctx.nativeSessions.size, 1)
    ctx.sessionController.inspect = async () => { throw Object.assign(new Error('missing'), { code: 'session/not-found' }) }
    assert.notEqual((await native.ensure(first, 'C:/workspace')).session_id, first.session_id)
  } finally { native.close() }
})

test('Harness result matches exact submitted message and turn, and excludes preambles/tools', async () => {
  const ctx = new FakeHarnessContext(); const native = new HarnessHost(ctx); const session = ctx.makeSession()
  const started = []
  const task = { id: 'task-one', session_id: session.id, prompt: 'work' }
  try {
    const done = native.run(task, { started: (id) => started.push(id) })
    await until(() => ctx.submitted)
    ctx.event(session.id, 'turn/start', { turn: 1 })
    ctx.event(session.id, 'user/message', { turn: 1, content: [{ type: 'text', text: 'different task' }], source: { kind: 'user', rpcId: 'someone' } })
    ctx.event(session.id, 'assistant/message', { turn: 1, step: 0, message: { content: [{ type: 'text', text: 'wrong answer' }] } })
    ctx.event(session.id, 'turn/end', { turn: 1, reason: 'completed' })
    ctx.event(session.id, 'turn/start', { turn: 2 })
    ctx.event(session.id, 'user/message', { turn: 2, content: ctx.submitted.message.content, source: ctx.submitted.message.source })
    ctx.event(session.id, 'assistant/message', { turn: 2, step: 0, message: { content: [{ type: 'text', text: 'preamble' }] } })
    ctx.event(session.id, 'tool/call', { turn: 2, callId: 'call', name: 'Bash', arguments: { command: 'SECRET COMMAND' } })
    ctx.event(session.id, 'tool/result', { turn: 2, content: 'SECRET OUTPUT' })
    ctx.event(session.id, 'assistant/message', { turn: 2, step: 1, message: { content: [{ type: 'text', text: 'verified final' }] } })
    ctx.event(session.id, 'turn/end', { turn: 2, reason: 'completed' })
    assert.deepEqual(await done, { status: 'completed', answer: 'verified final' })
    assert.deepEqual(started, ['2'])
    assert.deepEqual(await native.reconcile(task), { status: 'completed', answer: 'verified final' })
  } finally { native.close() }
})

test('Harness native approval is scoped to owned task and human answer', async () => {
  const ctx = new FakeHarnessContext(); const native = new HarnessHost(ctx); const session = ctx.makeSession()
  const task = { id: 'approval', session_id: session.id, prompt: 'work' }; let asked
  try {
    const done = native.run(task, { interaction: (v) => { asked = v } })
    await until(() => ctx.submitted)
    ctx.event(session.id, 'turn/start', { turn: 1 })
    ctx.event(session.id, 'user/message', { turn: 1, content: ctx.submitted.message.content, source: ctx.submitted.message.source })
    ctx.event(session.id, 'tool/call', { turn: 1, callId: 'call', arguments: JSON.stringify({ command: 'test' }) })
    ctx.event(session.id, 'approval/asked', { turn: 1, id: 'approval-id', callId: 'call' })
    const approval = native.approval({ agent: ctx.agents.get(session.id), toolName: 'Bash', callId: 'call' }, () => { throw new Error('should intercept owned approval') })
    assert.equal(asked.interaction_id, 'approval-id')
    await assert.rejects(native.decision({ id: 'other' }, { native_id: 'approval-id' }, 'allowed-once'), /interaction-not-pending/)
    await native.decision(task, { native_id: 'approval-id' }, 'rejected')
    assert.equal(await approval, 'rejected')
    ctx.event(session.id, 'turn/end', { turn: 1, reason: 'completed' }); await done
  } finally { native.close() }
})

test('Harness injects a producer-owned source kind admitted by session format v4', async () => {
  const ctx = new FakeHarnessContext(); const native = new HarnessHost(ctx); const session = ctx.makeSession()
  const task = { id: 'task-source', session_id: session.id, prompt: 'work' }
  try {
    const done = native.run(task)
    await until(() => ctx.submitted)
    const source = ctx.submitted.message.source
    // A bare `{ kind: 'plugin', plugin }` wrapper is retired in session format
    // v4 and rejected with "requires a producer-owned source kind".
    assert.notEqual(source.kind, 'plugin')
    assert.equal(source.kind, 'plugin:dsh-agent-hub')
    assert.equal(source.plugin, undefined)
    assert.equal(await native.landed(session.id, ctx.submitted.message.id), false)
    ctx.event(session.id, 'turn/start', { turn: 1 })
    ctx.event(session.id, 'user/message', { turn: 1, id: ctx.submitted.message.id, content: ctx.submitted.message.content, source })
    ctx.event(session.id, 'assistant/message', { turn: 1, step: 0, message: { content: [{ type: 'text', text: 'ok' }] } })
    ctx.event(session.id, 'turn/end', { turn: 1, reason: 'completed' })
    assert.deepEqual(await done, { status: 'completed', answer: 'ok' })
    assert.equal(await native.landed(session.id, ctx.submitted.message.id), true)
    assert.deepEqual(await native.reconcile(task), { status: 'completed', answer: 'ok' })
  } finally { native.close() }
})

test('question tool cannot submit fabricated answers; only observed human input is relayed', (t) => {
  const dir = temp(t); const hub = new Hub({ dbPath: join(dir, 'hub.sqlite'), adminToken: 'x' }); const ctx = new FakeHarnessContext()
  ctx.dshIm = {}; const native = { close() {} }; const coordinator = new MasterCoordinator(ctx, hub, { native })
  hub.store.put('tasks', { id: 'task', master_id: 'main', device_id: 'remote', attempt_id: 'attempt', binding_version: 1, status: 'waiting_input' })
  hub.store.put('interactions', { id: 'question', master_id: 'main', task_id: 'task', kind: 'question', resolved: false, expires_at: Date.now() + 10000, questions: [{ id: 'q', options: [{ label: 'A' }] }] })
  try {
    assert.throws(() => coordinator.answerQuestion('main', 'question', 'invented'), /human-answer-required/)
    hub.store.put('human_messages', { id: 'real', master_id: 'main', text: 'A', created_at: Date.now() })
    coordinator.answerQuestion('main', 'question', 'real')
    assert.deepEqual(hub.store.pending()[0].payload.answer, { answers: [{ id: 'q', selected: ['A'] }] })
  } finally { coordinator.close(); hub.store.close() }
})

test('remote approval requires exact operation and waits for the real native user decision', async (t) => {
  const dir = temp(t); const hub = new Hub({ dbPath: join(dir, 'hub.sqlite'), adminToken: 'x' }); const ctx = new FakeHarnessContext()
  ctx.dshIm = {}; let settle; let requested
  ctx.approval = { request: (req) => { requested = req; return new Promise((r) => { settle = r }) } }
  const coordinator = new MasterCoordinator(ctx, hub, { native: { close() {} } })
  hub.store.put('tasks', { id: 'task', master_id: 'main', device_id: 'remote', attempt_id: 'attempt', binding_version: 1, status: 'waiting_approval' })
  hub.store.put('interactions', { id: 'approval', master_id: 'main', task_id: 'task', kind: 'approval', arguments: { command: 'exact operation' }, resolved: false, expires_at: Date.now() + 10000 })
  try {
    const exec = { agent: { id: 'main' }, callId: 'native-call' }
    await assert.rejects(coordinator.reviewApproval('main', 'approval', { command: 'different operation' }, exec), /approval-operation-mismatch/)
    const decision = coordinator.reviewApproval('main', 'approval', { command: 'exact operation' }, exec)
    assert.equal(requested.callId, 'native-call')
    assert.equal(requested.toolName, 'agent_hub_review_approval')
    assert.equal(hub.store.pending().length, 0)
    settle('allowed-once'); await decision
    assert.equal(hub.store.pending()[0].payload.answer, 'allowed-once')
    await assert.rejects(coordinator.reviewApproval('main', 'approval', { command: 'exact operation' }, exec), /interaction-not-pending/)
  } finally { coordinator.close(); hub.store.close() }
})

test('local sub agent events cannot finish the remote task; only parent Harness final answer is returned', async () => {
  const ctx = new FakeHarnessContext(), host = new HarnessHost(ctx)
  const parent = ctx.makeSession('parent'), child = ctx.makeSession('local-codex-subagent')
  let settled = false
  try {
    const done = host.run({ id: 'delegated', runtime: 'harness', session_id: parent.id, prompt: '请用 Codex 完成并核查' }).then(r => { settled = true; return r })
    await until(() => ctx.submitted)
    assert.match(ctx.submitted.message.content[0].text, /sub agent/)
    ctx.event(parent.id, 'turn/start', { turn: 4 })
    ctx.event(parent.id, 'user/message', { turn: 4, source: ctx.submitted.message.source, content: ctx.submitted.message.content })
    ctx.event(child.id, 'assistant/message', { turn: 4, step: 0, message: { content: [{ type: 'text', text: 'PRIVATE CHILD OUTPUT' }] } })
    ctx.event(child.id, 'turn/end', { turn: 4, reason: 'completed' })
    await new Promise(r => setImmediate(r)); assert.equal(settled, false)
    ctx.event(parent.id, 'assistant/message', { turn: 4, step: 1, message: { content: [{ type: 'text', text: 'Codex 子任务已结束，验证通过，产物保存在本机。' }] } })
    ctx.event(parent.id, 'turn/end', { turn: 4, reason: 'completed' })
    const result = await done
    assert.equal(result.status, 'completed'); assert.equal(JSON.stringify(result).includes('PRIVATE'), false)
  } finally { host.close() }
})

test('renamed plugin reconciles an older producer source without submitting the task again', async () => {
  const ctx = new FakeHarnessContext(), host = new HarnessHost(ctx), s = ctx.makeSession('retained')
  ctx.event(s.id, 'turn/start', { turn: 2 })
  ctx.event(s.id, 'user/message', { turn: 2, source: { kind: 'plugin:dsh-agent-hub-v2' }, content: [{ type: 'text', text: '【Agent Hub task=old】\nwork' }] })
  ctx.event(s.id, 'assistant/message', { turn: 2, step: 0, message: { content: [{ type: 'text', text: 'retained result' }] } })
  ctx.event(s.id, 'turn/end', { turn: 2, reason: 'completed' })
  try { assert.deepEqual(await host.reconcile({ id: 'old', session_id: s.id }), { status: 'completed', answer: 'retained result' }); assert.equal(ctx.submitted, undefined) } finally { host.close() }
})
