import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { Store } from '../src/store.js'
import { frame } from '../src/protocol.js'
import { Hub } from '../src/hub.js'
import { temp } from './helpers.js'

test('failed receipt transaction retains the event and does not leave an audit receipt falsely claiming removal', (t) => {
  const dir = temp(t); const store = new Store(join(dir, 'store.sqlite'))
  try {
    const fields = { task_id: 'task', attempt_id: 'attempt', binding_version: 1 }
    const event = frame('task.result', { status: 'completed' }, fields); store.enqueue(event)
    store.db.exec("CREATE TRIGGER fail_delete BEFORE DELETE ON outbox BEGIN SELECT RAISE(ABORT, 'simulated storage failure'); END")
    assert.throws(() => store.acknowledge(frame('ack', { ack_id: event.message_id, persisted: true }, fields)), /storage failure/)
    assert.equal(store.pending().length, 1)
    assert.equal(store.receipt('ack:' + event.message_id), null)
    store.db.exec('DROP TRIGGER fail_delete')
    assert.equal(store.acknowledge(frame('ack', { ack_id: event.message_id, persisted: true }, fields)), true)
  } finally { store.close() }
})

test('Hub only acknowledges a result after task, mailbox and receipt commit atomically', (t) => {
  const dir = temp(t); const hub = new Hub({ dbPath: join(dir, 'hub.sqlite'), adminToken: 'x' })
  const task = { id: 'task', attempt_id: 'attempt', binding_version: 1, device_id: 'device', master_id: 'main', status: 'running' }
  hub.store.put('tasks', task)
  const replies = []; const c = { device: { id: 'device' }, ready: true, ws: { send: (raw) => replies.push(JSON.parse(raw)) } }
  const result = frame('task.result', { status: 'completed', answer: 'final' }, { task_id: task.id, attempt_id: task.attempt_id, binding_version: 1 })
  try {
    hub.store.db.exec("CREATE TRIGGER fail_mailbox BEFORE INSERT ON records WHEN NEW.bucket='mailbox' BEGIN SELECT RAISE(ABORT, 'simulated storage failure'); END")
    assert.throws(() => hub.handleMessage(c, result), /storage failure/)
    assert.equal(replies.length, 0)
    assert.equal(hub.store.get('tasks', task.id).status, 'running')
    assert.equal(hub.store.receipt(result.message_id), null)
    hub.store.db.exec('DROP TRIGGER fail_mailbox')
    hub.handleMessage(c, result)
    assert.equal(replies[0].payload.persisted, true)
    assert.equal(hub.store.get('tasks', task.id).status, 'completed')
    assert.equal(hub.store.get('mailbox', task.id).state, 'pending')
  } finally { hub.store.close() }
})

test('completion notification is committed with the result and receipt before Worker acknowledgement', (t) => {
  const hub = new Hub({ dbPath: join(temp(t), 'hub.sqlite'), adminToken: 'x' })
  hub.bindMaster({ session_id: 'main', bot_id: 'wx', target_id: 'user' })
  const task = { id: 'task', master_id: 'main', device_id: 'device', attempt_id: 'a', binding_version: 1, status: 'running' }
  hub.store.put('tasks', task)
  const replies = [], c = { device: { id: 'device' }, ready: true, ws: { send: raw => replies.push(JSON.parse(raw)) } }
  const message = frame('task.result', { status: 'completed', answer: 'final' }, { task_id: task.id, attempt_id: 'a', binding_version: 1 })
  try {
    hub.store.db.exec("CREATE TRIGGER fail_notice BEFORE INSERT ON records WHEN NEW.bucket='notifications' BEGIN SELECT RAISE(ABORT, 'notice write failure'); END")
    assert.throws(() => hub.handleMessage(c, message), /notice write failure/)
    assert.equal(replies.length, 0); assert.equal(hub.store.get('tasks', task.id).status, 'running'); assert.equal(hub.store.receipt(message.message_id), null)
    hub.store.db.exec('DROP TRIGGER fail_notice')
    hub.handleMessage(c, message); hub.handleMessage(c, message)
    assert.equal(hub.store.all('notifications').length, 1)
    assert.equal(hub.store.all('notifications')[0].state, 'pending')
    assert.equal(replies.every(r => r.payload.persisted === true), true)
  } finally { hub.store.close() }
})
