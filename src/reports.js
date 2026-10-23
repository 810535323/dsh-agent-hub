import { now } from './util.js'
import { TERMINAL } from './protocol.js'

export const reportable = (task) => !!task && (TERMINAL.has(task.status) || task.status === 'uncertain')
export const reportRevision = (task) => task.result_message_id || task.finished_at || `${task.status}:${task.attempt_id || 'legacy'}`
export const noticeId = (task) => `task-notice:${task.id}:${reportRevision(task)}`
const labels = { completed: '执行结束（业务结果以验证证据为准）', failed: '执行失败', cancelled: '已取消', interrupted: '执行中断', uncertain: '执行状态待核查，请勿自动重跑' }

export function completionText(task, device) {
  const result = task.result || {}
  const lines = [`【远程任务通知】${labels[task.status] || task.status}`, `任务：${task.id}`, `设备：${device?.name || task.device_id || '未知'}`]
  if (task.finished_at) lines.push(`结果接收时间：${task.finished_at}`)
  if (result.answer?.trim()) lines.push('从机最终答复摘录：\n' + result.answer.trim().slice(0, 1600))
  if (result.answer?.length > 1600) lines.push('完整最终答复已保存，可让主 Agent 查询此任务。')
  if (result.verification?.length) lines.push('验证摘要：\n' + result.verification.slice(0, 3).map(v => String(v).slice(0, 250)).join('\n'))
  if (Number.isInteger(result.exit_code)) lines.push('退出码：' + result.exit_code)
  if (result.artifacts?.length) lines.push('产物保存在执行设备：\n' + result.artifacts.slice(0, 3).map(a => a.path).join('\n'))
  return lines.join('\n')
}

// Call inside the same transaction as result/receipt persistence. Re-running is idempotent.
export function ensureTaskNotice(store, task) {
  if (!reportable(task) || typeof task.master_id !== 'string') return
  const id = noticeId(task)
  if (store.get('notifications', id)) return
  const master = store.get('masters', task.master_id)
  if (!master) return
  const legacy = store.get('notifications', task.id)
  const legacyApplies = legacy && (!task.finished_at || !legacy.sent_at || Date.parse(legacy.sent_at) >= Date.parse(task.finished_at))
  const state = legacyApplies && ['sending', 'unknown'].includes(legacy.state) ? 'unknown'
    : legacyApplies && legacy.state === 'sent' ? 'sent' : 'pending'
  store.put('notifications', {
    id, task_id: task.id, revision: reportRevision(task), kind: 'task-status', master_id: task.master_id,
    bot_id: master.bot_id, target_id: master.target_id,
    text: completionText(task, typeof task.device_id === 'string' ? store.get('devices', task.device_id) : null), state, tries: 0, created_at: now(),
    ...(state !== 'pending' ? { legacy_notification_id: legacy.id, ...(legacy.sent_at ? { sent_at: legacy.sent_at } : {}) } : {}),
  })
}
