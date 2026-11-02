import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { Hub } from '../src/hub.js'
import { frame, taskFields } from '../src/protocol.js'
import { reportable } from '../src/reports.js'
import { temp } from './helpers.js'

function fixture(t) {
  const hub = new Hub({ dbPath: join(temp(t), 'hub.sqlite'), adminToken: 'test' })
  hub.bindMaster({ session_id: 'main', bot_id: 'wx', target_id: 'user' })
  const device = { id: 'device', master_id: 'main' }
  hub.store.put('devices', device)
  hub.store.put('endpoints', { id: 'device:harness', device_id: device.id, runtime: 'harness', session_id: 'harness-session', binding_version: 1, ready: true })
  const sent = [], connection = { device, ready: true, lastSeen: Date.now(), ws: { readyState: WebSocket.OPEN, send: raw => sent.push(JSON.parse(raw)) } }
  hub.connections.set(device.id, connection)
  t.after(() => hub.store.close())
  const dispatch = (prompt, codex) => hub.dispatch('main', { endpoint_id: 'device:harness', prompt, ...(codex ? { codex } : {}) })
  const complete = (task, value) => {
    const message = frame('task.result', { status: 'completed', answer: JSON.stringify(value) }, taskFields(task))
    hub.handleMessage(connection, message)
    return message
  }
  return { hub, dispatch, complete, sent, connection }
}
const candidate = (extra = {}) => ({ session_id: 'codex-session-one', title: 'alpha 项目', cwd: 'D:/projects/alpha', updated_at: new Date().toISOString(), state: 'idle', match_reason: '同项目与任务', ...extra })
const results = (...sessions) => ({ codex_session_search: { available: true, candidates: sessions } })

test('Codex defaults to an independent saved task and does not reuse an existing session', t => {
  const { hub, dispatch } = fixture(t)
  hub.store.put('codex_sessions', { id: 'device:old', device_id: 'device', session_id: 'old' })
  const task = dispatch('用 Codex 实现 alpha 模块')
  assert.equal(task.codex_call?.mode, 'single')
  assert.equal(hub.store.all('tasks').length, 1)
  assert.equal(task.codex_call?.session_id, undefined)
})

test('continuation searches on the worker, then dispatches one exact-session follow-up from verified unique results', t => {
  const { hub, dispatch, complete, connection } = fixture(t)
  const search = dispatch('继续上次 Codex 的 alpha 模块', { project_path: 'D:/projects/alpha' })
  assert.equal(search.codex_call?.mode, 'search')
  const message = complete(search, results(candidate()))
  const tasks = hub.store.all('tasks'), child = tasks.find(task => task.id !== search.id)
  assert.equal(tasks.length, 2)
  assert.equal(child.codex_call.mode, 'resume')
  assert.equal(child.codex_call.session_id, 'codex-session-one')
  assert.equal(child.codex_call.search_task_id, search.id)
  assert.equal(reportable(hub.store.get('tasks', search.id)), false)
  assert.equal(hub.store.all('notifications').some(n => n.task_id === search.id), false)
  hub.handleMessage(connection, message); hub.codex.tick()
  assert.equal(hub.store.all('tasks').length, 2)
})

test('a related running task is found before creating another worker task', t => {
  const { hub, dispatch } = fixture(t)
  const existing = dispatch('用 Codex 实现 alpha 数据采集')
  hub.store.put('tasks', { ...hub.store.get('tasks', existing.id), status: 'running' })
  const selected = dispatch('继续正在执行的 alpha 数据采集任务', { mode: 'continue' })
  assert.equal(selected.action, 'wait')
  assert.equal(selected.related_tasks[0].id, existing.id)
  assert.equal(hub.store.all('tasks').length, 1)
})

for (const [name, sessions, expected] of [
  ['several candidates', [candidate(), candidate({ session_id: 'codex-session-two' })], 'needs_selection'],
  ['running native turn', [candidate({ state: 'active' })], 'running'],
  ['unknown native state', [candidate({ state: 'unknown' })], 'needs_verification'],
  ['no candidate', [], 'not_found'],
  ['different project', [candidate({ cwd: 'D:/projects/other' })], 'not_found'],
]) test(`${name} never starts a guessed, duplicate or replacement Codex session`, t => {
  const { hub, dispatch, complete } = fixture(t)
  const search = dispatch('继续 Codex alpha 任务', { project_path: 'D:/projects/alpha' })
  complete(search, results(...sessions))
  assert.equal(hub.store.all('tasks').length, 1)
  const stored = hub.store.get('tasks', search.id)
  assert.equal(stored.codex_resolution?.state, expected)
  assert.equal(reportable(stored), true)
})

test('an explicitly supplied session still requires a fresh worker lookup and exact identity match', t => {
  const { hub, dispatch, complete } = fixture(t)
  const search = dispatch('继续 Codex alpha', { session_id: 'selected-session', project_path: 'D:/projects/alpha' })
  assert.equal(search.codex_call?.mode, 'search')
  complete(search, results(candidate()))
  assert.equal(hub.store.all('tasks').length, 1)
  assert.equal(hub.store.get('tasks', search.id).codex_resolution.state, 'not_found')
})

test('lookup metadata is allowlisted; conversation history and arbitrary command output cannot enter search results', t => {
  const { hub, dispatch, complete } = fixture(t)
  const search = dispatch('查找 Codex alpha 会话', { mode: 'search' })
  complete(search, { codex_session_search: { available: true, transcript: 'PRIVATE_HISTORY', candidates: [candidate({ raw_output: 'PRIVATE_OUTPUT', credentials: 'PRIVATE_KEY' })] } })
  const stored = hub.store.get('tasks', search.id)
  assert.equal(/PRIVATE_/.test(JSON.stringify(stored.result)), false)
  assert.equal(stored.codex_resolution.state, 'search_complete')
  assert.equal(hub.store.all('tasks').length, 1)
})

test('changed bindings or an offline device prevent follow-up dispatch after the lookup completed', t => {
  const { hub, dispatch, complete } = fixture(t)
  const search = dispatch('继续 Codex alpha')
  hub.store.put('endpoints', { ...hub.store.get('endpoints', 'device:harness'), binding_version: 2 })
  complete(search, results(candidate()))
  assert.equal(hub.store.all('tasks').length, 1)
  assert.equal(hub.store.get('tasks', search.id).codex_resolution.state, 'binding_changed')
})

test('task relevance search is isolated by master and explicit task references cannot cross devices', t => {
  const { hub, dispatch } = fixture(t)
  const own = dispatch('用 Codex 实现 alpha 行情')
  hub.store.put('tasks', { id: 'secret-task', master_id: 'other', endpoint_id: 'device:harness', request_prompt: 'alpha', status: 'running' })
  assert.deepEqual(hub.codex.searchTasks('main', { query: 'alpha' }).map(t => t.id), [own.id])
  assert.throws(() => dispatch('继续 Codex 任务', { task_id: 'secret-task' }), /unknown-task/)
})

test('an older active task cannot be hidden by many newer completed search matches', t => {
  const { hub, dispatch } = fixture(t)
  const active = dispatch('用 Codex 实现 alpha 数据采集')
  hub.store.put('tasks', { ...hub.store.get('tasks', active.id), status: 'running', created_at: '2026-01-01T00:00:00Z' })
  for (let i = 0; i < 30; i++) hub.store.put('tasks', { id: 'finished-' + i, master_id: 'main', endpoint_id: 'device:harness', status: 'completed', request_prompt: 'Codex alpha 数据采集', created_at: new Date().toISOString() })
  const response = dispatch('继续正在执行的 alpha 数据采集 Codex 任务')
  assert.equal(response.action, 'wait')
  assert.equal(response.related_tasks[0].id, active.id)
  assert.equal(hub.store.all('tasks').length, 31)
})

test('project-scoped continuation does not attach to a same-named active task from another project', t => {
  const { hub, dispatch } = fixture(t)
  const other = dispatch('用 Codex 实现 alpha', { project_path: 'D:/other' })
  hub.store.put('tasks', { ...hub.store.get('tasks', other.id), status: 'running' })
  const response = dispatch('继续 Codex alpha', { project_path: 'D:/projects/alpha' })
  assert.equal(response.codex_call?.mode, 'search')
})

test('cancelling the lookup suppresses automatic continuation even if the worker later completes that lookup', t => {
  const { hub, dispatch, complete } = fixture(t)
  const search = dispatch('继续 Codex alpha')
  hub.cancel('main', search.id)
  complete(search, results(candidate()))
  assert.equal(hub.store.all('tasks').length, 1)
  assert.equal(hub.store.get('tasks', search.id).codex_resolution.state, 'cancelled')
})

test('cancelling the original lookup ID forwards cancellation to its live follow-up task', t => {
  const { hub, dispatch, complete } = fixture(t)
  const search = dispatch('继续 Codex alpha')
  complete(search, results(candidate()))
  const childId = hub.store.get('tasks', search.id).codex_resolution.task_id
  hub.cancel('main', search.id)
  assert.equal(hub.store.get('tasks', childId).cancel_requested, true)
})

test('a disconnected device is not queued to resume on reconnect after search', t => {
  const { hub, dispatch, complete, connection } = fixture(t)
  const search = dispatch('继续 Codex alpha')
  const tick = hub.codex.tick.bind(hub.codex)
  hub.codex.tick = () => {}
  complete(search, results(candidate()))
  connection.ready = false
  hub.codex.tick = tick; tick()
  assert.equal(hub.store.all('tasks').length, 1)
  assert.equal(hub.store.get('tasks', search.id).codex_resolution.state, 'device_unavailable')
  connection.ready = true; hub.codex.tick()
  assert.equal(hub.store.all('tasks').length, 1)
})

test('query linkage and child dispatch commit atomically, so a failed link never duplicates continuation', t => {
  const { hub, dispatch, complete } = fixture(t)
  const search = dispatch('继续 Codex alpha')
  hub.store.db.exec("CREATE TRIGGER fail_link BEFORE UPDATE ON records WHEN NEW.bucket='tasks' AND json_extract(NEW.value, '$.codex_resolution.state')='continued' BEGIN SELECT RAISE(ABORT, 'link failure'); END")
  complete(search, results(candidate()))
  assert.equal(hub.store.all('tasks').length, 1)
  assert.equal(hub.store.pending().filter(m => m.type === 'task.dispatch').length, 1)
  hub.store.db.exec('DROP TRIGGER fail_link')
  hub.codex.tick(); hub.codex.tick()
  assert.equal(hub.store.all('tasks').length, 2)
})

test('a partially malformed candidate list cannot become a false unique match after filtering', t => {
  const { hub, dispatch, complete } = fixture(t)
  const search = dispatch('继续 Codex alpha')
  complete(search, results(candidate(), { title: '另一个候选但没有可信编号' }))
  assert.equal(hub.store.all('tasks').length, 1)
  assert.equal(hub.store.get('tasks', search.id).codex_resolution.state, 'lookup_failed')
})

test('saved Codex session IDs and verification survive a completed single task without storing history', t => {
  const { hub, dispatch, complete } = fixture(t)
  const task = dispatch('用 Codex 实现 alpha')
  complete(task, { answer: '执行完成', codex_session: candidate(), verification: ['unit tests passed'], transcript: 'PRIVATE_HISTORY' })
  const stored = hub.store.get('tasks', task.id)
  assert.equal(stored.result.answer, '执行完成')
  assert.deepEqual(stored.result.verification, ['unit tests passed'])
  assert.equal(hub.store.get('codex_sessions', 'device:codex-session-one').session_id, 'codex-session-one')
  assert.equal(JSON.stringify(stored.result).includes('PRIVATE_HISTORY'), false)
})

test('a completed task reference contributes its actual Codex identity and project to fresh discovery', t => {
  const { hub, dispatch, complete } = fixture(t)
  const original = dispatch('用 Codex 完成 alpha 行情项目', { project_path: 'D:/projects/alpha' })
  complete(original, { answer: 'done', codex_session: candidate() })
  const search = dispatch('继续 Codex', { task_id: original.id })
  assert.equal(search.codex_call.session_id, 'codex-session-one')
  assert.equal(search.codex_call.project_path, 'D:/projects/alpha')
  assert.match(search.codex_call.query, /alpha/)
  assert.equal(hub.store.all('tasks').length, 2)
})

for (const [status, action] of [['running', 'wait'], ['uncertain', 'needs_reconciliation'], ['waiting_approval', 'interaction_required']]) {
  test(`explicit native Session ID finds its ${status} task without needing prompt keywords`, t => {
    const { hub, dispatch, complete } = fixture(t)
    const first = dispatch('继续 Codex', { session_id: 'codex-session-one' })
    complete(first, results(candidate()))
    const childId = hub.store.get('tasks', first.id).codex_resolution.task_id
    hub.store.put('tasks', { ...hub.store.get('tasks', childId), status })
    const next = dispatch('继续 Codex', { session_id: 'codex-session-one' })
    assert.equal(next.action, action)
    assert.equal(next.related_tasks[0].id, childId)
    assert.equal(hub.store.all('tasks').length, 2)
  })
}

test('referencing the original search ID follows its live child rather than starting another search', t => {
  const { hub, dispatch, complete } = fixture(t)
  const first = dispatch('继续 Codex alpha')
  complete(first, results(candidate()))
  const childId = hub.store.get('tasks', first.id).codex_resolution.task_id
  const next = dispatch('继续 Codex', { task_id: first.id })
  assert.equal(next.action, 'wait')
  assert.equal(next.related_tasks[0].id, childId)
  assert.equal(hub.store.all('tasks').length, 2)
})

test('another task claiming the native session during discovery blocks the follow-up at dispatch time', t => {
  const { hub, dispatch, complete } = fixture(t)
  const search = dispatch('继续 Codex alpha')
  hub.store.put('tasks', { id: 'already-resuming', master_id: 'main', endpoint_id: 'device:harness', status: 'running', codex_call: { mode: 'resume', session_id: 'codex-session-one', project_path: 'D:/projects/alpha' } })
  complete(search, results(candidate()))
  assert.equal(hub.store.all('tasks').length, 2)
  assert.equal(hub.store.get('tasks', search.id).codex_resolution.state, 'running')
})

test('an explicit continuation result from the wrong project is reported as a mismatch rather than success', t => {
  const { hub, dispatch, complete } = fixture(t)
  const search = dispatch('继续 Codex alpha')
  complete(search, results(candidate()))
  const child = hub.store.get('tasks', hub.store.get('tasks', search.id).codex_resolution.task_id)
  complete(child, { answer: 'done', codex_session: candidate({ cwd: 'D:/wrong-project' }) })
  assert.equal(hub.store.get('tasks', child.id).status, 'failed')
  assert.equal(hub.store.get('tasks', child.id).result.reason, 'codex-session-project-mismatch')
})

test('a completed task reference also checks other active tasks using the same native session', t => {
  const { hub, dispatch, complete } = fixture(t)
  const original = dispatch('用 Codex 完成 alpha')
  complete(original, { answer: 'done', codex_session: candidate() })
  hub.store.put('tasks', { id: 'new-active', master_id: 'main', endpoint_id: 'device:harness', status: 'running', codex_call: { mode: 'resume', session_id: 'codex-session-one', project_path: 'D:/projects/alpha' } })
  const next = dispatch('继续 Codex', { task_id: original.id })
  assert.equal(next.action, 'wait')
  assert.equal(next.related_tasks[0].id, 'new-active')
  assert.equal(hub.store.all('tasks').length, 2)
})

test('finding previous Codex sessions is read-only even when the prompt mentions previous work', t => {
  const { hub, dispatch, complete } = fixture(t)
  const search = dispatch('查找之前的 Codex alpha 会话')
  assert.equal(search.codex_call.continue_after_search, false)
  complete(search, results(candidate()))
  assert.equal(hub.store.all('tasks').length, 1)
})

test('rejected session identity cannot replace the intended resume binding on a later task reference', t => {
  const { hub, dispatch, complete } = fixture(t)
  const search = dispatch('继续 Codex alpha')
  complete(search, results(candidate()))
  const child = hub.store.get('tasks', hub.store.get('tasks', search.id).codex_resolution.task_id)
  complete(child, { answer: 'wrong session', codex_session: candidate({ session_id: 'wrong-session', cwd: 'D:/wrong' }) })
  const next = dispatch('继续 Codex', { task_id: child.id })
  assert.equal(next.codex_call.session_id, 'codex-session-one')
  assert.equal(next.codex_call.project_path, 'D:/projects/alpha')
  assert.equal(hub.store.get('codex_sessions', 'device:wrong-session'), null)
})
