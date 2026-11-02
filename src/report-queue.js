import { fail, now } from './util.js'
import { ensureTaskNotice, reportable, reportRevision, noticeId } from './reports.js'

// Durable Agent consumption is separate from the independent WeChat delivery queue.
export class ReportQueue {
  constructor(hub) { this.hub = hub }
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
    const deliveryIssues = this.hub.store.all('notifications').filter(n => n.kind === 'task-status' && !['sent', 'superseded'].includes(n.state)).map(({ id, task_id, master_id, state, tries, reason, created_at }) => ({ id, task_id, master_id, state, tries, reason, created_at }))
    return { pending_count: items.length, items: items.slice(0, 50).map(({ result, ...r }) => ({ ...r, answer_excerpt: result?.answer?.slice(0, 800) || '' })), delivery_issues: deliveryIssues }
  }
  close() { this.closed = true }
}
