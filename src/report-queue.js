import { randomUUID } from 'node:crypto'
import { fail, now, safeError } from './util.js'
import { ensureTaskNotice, reportable, reportRevision, noticeId } from './reports.js'

// Durable Agent consumption is separate from the independent WeChat delivery queue.
export class ReportQueue {
  constructor(hub, native, { reminderIntervalMs = 60000 } = {}) {
    this.hub = hub; this.native = native; this.reminderIntervalMs = reminderIntervalMs
  }
  repairBacklog() {
    const store = this.hub.store
    store.transaction(() => {
      for (const task of store.all('tasks').filter(reportable)) {
        const revision = reportRevision(task), mail = store.get('mailbox', task.id)
        if (!mail) store.put('mailbox', { id: task.id, task_id: task.id, master_id: task.master_id, revision, state: 'pending', created_at: task.finished_at || now() })
        // A legacy consumed row already completed its main-Agent report. Do not resurrect it.
        else if (mail.state === 'consumed' && !mail.revision && !mail.agent_consumed_revision) store.put('mailbox', { ...mail, revision, agent_consumed_revision: revision, agent_consumed_at: mail.consumed_at || now() })
        ensureTaskNotice(store, task)
      }
    })
  }
  pendingReports(masterId, limit = 20) {
    return this.hub.store.all('mailbox').filter(m => m.master_id === masterId && !m.interaction_id).flatMap(mail => {
      const task = this.hub.store.get('tasks', mail.task_id)
      if (!reportable(task) || task.master_id !== masterId) return []
      const revision = reportRevision(task)
      if (mail.agent_consumed_revision === revision || mail.state === 'consumed' && !mail.revision) return []
      const delivery = this.hub.store.get('notifications', noticeId(task))
      return [{ report_id: mail.id, revision, task_id: task.id, device_id: task.device_id, status: task.status, finished_at: task.finished_at || null, result: task.result || null, reason: task.reason || null, delivery: delivery?.state || 'pending', created_at: mail.created_at }]
    }).sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || ''))).slice(0, limit)
  }
  acknowledgeReports(masterId, reports) {
    if (!Array.isArray(reports) || !reports.length || reports.length > 20) throw fail('invalid-reports')
    const checked = reports.map(r => {
      if (!r || typeof r.report_id !== 'string' || typeof r.revision !== 'string') throw fail('invalid-reports')
      const mail = this.hub.store.get('mailbox', r.report_id), task = mail && this.hub.store.get('tasks', mail.task_id)
      if (!mail || mail.interaction_id || mail.master_id !== masterId || task?.master_id !== masterId || !reportable(task)) throw fail('unknown-report')
      if (r.revision !== reportRevision(task)) throw fail('stale-report-revision')
      return { mail, revision: r.revision }
    })
    this.hub.store.transaction(() => {
      for (const { mail, revision } of checked) {
        const id = mail.id + ':' + revision
        if (!this.hub.store.get('report_consumption', id)) this.hub.store.put('report_consumption', { id, report_id: mail.id, revision, master_id: masterId, consumed_at: now() })
        this.hub.store.put('mailbox', { ...mail, revision, state: 'consumed', agent_consumed_revision: revision, agent_consumed_at: this.hub.store.get('report_consumption', id).consumed_at })
      }
    })
    return { acknowledged: checked.map(r => r.mail.id) }
  }
  reportStatus() {
    const items = this.hub.store.all('masters').flatMap(m => this.pendingReports(m.id, Number.MAX_SAFE_INTEGER).map(r => ({ ...r, master_id: m.id })))
    const deliveryIssues = this.hub.store.all('notifications').filter(n => n.kind === 'task-status' && n.state !== 'sent').map(({ id, task_id, master_id, state, tries, reason, created_at }) => ({ id, task_id, master_id, state, tries, reason, created_at }))
    return { pending_count: items.length, items: items.slice(0, 50).map(({ result, ...r }) => ({ ...r, answer_excerpt: result?.answer?.slice(0, 800) || '' })), delivery_issues: deliveryIssues, wakeups: this.hub.store.all('report_wakeups') }
  }
  async wakeResults(masterId) {
    const reports = this.pendingReports(masterId), master = this.hub.store.get('masters', masterId)
    if (!master || !reports.length || !this.native.enqueue || !await this.native.isIdle(master.session_id)) return
    const signature = reports.map(r => r.report_id + ':' + r.revision).join('|')
    const previous = this.hub.store.get('report_wakeups', masterId)
    const same = previous?.signature === signature
    if (same && previous.queued_at && Date.now() - previous.queued_at < this.reminderIntervalMs) return
    if (same && previous.attempts >= 3) return // Queue remains visible and queryable until explicit consumption.
    const messageId = same && previous.state === 'enqueuing' ? previous.message_id : randomUUID()
    const record = { id: masterId, signature, message_id: messageId, attempts: same ? previous.attempts || 0 : 0, state: 'enqueuing', queued_at: Date.now() }
    try {
      const result = await this.native.enqueue({ session_id: master.session_id, prompt: `【Agent Hub 待处理结果】有 ${reports.length} 项任务结果尚未确认消费。请先调用 agent_hub_pending_reports 获取持久结果，再调用 agent_hub_ack_reports 确认已阅读的 report_id 和 revision。执行结束通知由插件独立投递微信；无需再发相同的通知。只在用户需要时整理详细结论，不重新执行任务。任务编号：${reports.map(r => r.task_id).join('、')}` }, {
        messageId, beforeSubmit: () => this.hub.store.put('report_wakeups', record),
      })
      if (this.closed) return
      this.hub.store.put('report_wakeups', { ...record, state: result.queued ? 'queued' : 'waiting_idle', attempts: record.attempts + (result.queued ? 1 : 0), ...(result.queued ? {} : { queued_at: 0 }) })
    } catch (error) {
      if (!this.closed) this.hub.store.put('report_wakeups', { ...record, state: 'enqueuing', last_error: safeError(error) })
    }
  }
  close() { this.closed = true }
}
