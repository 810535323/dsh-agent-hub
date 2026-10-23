import { randomUUID } from 'node:crypto'
import { fail, requireText } from './util.js'

export const VERSION = 2
export const MAX_FRAME = 256 * 1024
export const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted'])
export const ACTIVE = new Set(['accepted', 'starting', 'running', 'waiting_approval', 'waiting_input', 'uncertain'])
export function frame(type, payload = {}, fields = {}) {
  return { version: VERSION, message_id: randomUUID(), type, ...fields, payload }
}
export function parseFrame(raw) {
  if (Buffer.byteLength(raw) > MAX_FRAME) throw fail('frame-too-large')
  const m = JSON.parse(String(raw))
  if (!m || m.version !== VERSION) throw fail('protocol-version')
  requireText(m.message_id, 'message-id', 128)
  requireText(m.type, 'message-type', 80)
  if (!m.payload || typeof m.payload !== 'object' || Array.isArray(m.payload)) throw fail('invalid-payload')
  return m
}
export function taskFields(task) {
  return { task_id: task.id, attempt_id: task.attempt_id, binding_version: task.binding_version }
}
export function matchesTask(task, m) {
  return task && task.id === m.task_id && task.attempt_id === m.attempt_id && task.binding_version === m.binding_version
}
export function resultOnly(value = {}) {
  const status = TERMINAL.has(value.status) ? value.status : 'failed'
  const result = { status, business_outcome: 'unassessed', answer: typeof value.answer === 'string' ? value.answer.slice(0, 32768) : '', verification: [], artifacts: [] }
  if (typeof value.reason === 'string' && /^[a-zA-Z0-9_/-]{1,100}$/.test(value.reason)) result.reason = value.reason
  if (Number.isInteger(value.exit_code)) result.exit_code = value.exit_code
  if (value.execution_summary && typeof value.execution_summary === 'object') {
    const s = value.execution_summary
    result.execution_summary = {
      command_count: Number.isSafeInteger(s.command_count) && s.command_count >= 0 ? s.command_count : 0,
      failed_commands: Number.isSafeInteger(s.failed_commands) && s.failed_commands >= 0 ? s.failed_commands : 0,
      exit_codes: Array.isArray(s.exit_codes) ? s.exit_codes.filter(Number.isInteger).slice(0, 100) : [],
    }
  }
  // These are summaries and references explicitly produced for this task, never native log objects.
  if (Array.isArray(value.verification)) result.verification = value.verification.filter((x) => typeof x === 'string').slice(0, 20).map((x) => x.slice(0, 1000))
  if (Array.isArray(value.artifacts)) result.artifacts = value.artifacts.filter((x) => x && typeof x.path === 'string').slice(0, 30).map((x) => ({ path: x.path.slice(0, 2000), ...(typeof x.title === 'string' ? { title: x.title.slice(0, 200) } : {}) }))
  return result
}
