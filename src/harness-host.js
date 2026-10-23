import { randomUUID } from 'node:crypto'
import { fail } from './util.js'

export const PLUGIN = 'dsh-agent-hub'
// Session format v4 admits only producer-owned source kinds: a bare
// `{ kind: 'plugin', plugin }` wrapper is retired and rejected by persistence
// with "format v4 message requires a producer-owned source kind". The V3→V4
// migration rewrites that wrapper to `plugin:<name>`, so a plugin that injects
// messages natively must use the same producer-owned kind directly.
export const SOURCE_KIND = `plugin:${PLUGIN}`
export const SOURCE = Object.freeze({ kind: SOURCE_KIND })
const text = (content = []) => content.filter((b) => b.type === 'text').map((b) => b.text).join('\n')
const codeOf = (e) => e?.code || e?.failure?.code
const missing = (e) => ['session/not-found', 'session-not-found', 'SESSION_QUERY_SESSION_NOT_FOUND'].includes(codeOf(e)) || e?.constructor?.name === 'ApiSessionNotFound'

// Native Host integration verified against the installed Harness 0.2.1-rc.2.
// Uses the Host's composition-aware resolver; never resumes a bare agent without its preset.
export class HarnessHost {
  constructor(ctx) {
    if (!ctx.sessionController?.inspect || !ctx.sessionController?.resolveAgent || !ctx.typertGateway?.invoke) throw fail('unsupported-harness-host')
    this.ctx = ctx; this.active = new Map(); this.interactions = new Map()
    this.disposers = [
      ctx.on('session/event', (session, event) => this.event(session, event), { global: true }),
      ctx.on('approval/request', (req, next) => this.approval(req, next), { global: true, prepend: true }),
      ctx.on('user-questions/request', (req, next) => this.question(req, next), { global: true, prepend: true }),
    ]
    this.peer = ctx.connection?.createPeer?.({ principal: { kind: 'owner' }, interactions: 'none' })
  }
  invoke(method, request) { return this.ctx.typertGateway.invoke({ namespace: 'session', method, args: { request }, ...(this.peer ? { peer: this.peer } : {}) }) }
  async inspect(id) { return this.ctx.sessionController.inspect(id) }
  // True when the exact injected message reached the session (as a user message
  // or as a spliced inbox entry), so a pending callback is not re-submitted
  // while its turn is still running.
  async landed(sessionId, messageId) {
    if (!messageId) return false
    const session = await this.inspect(sessionId)
    return (session.events || []).some((e) => {
      const d = e.data || {}
      if (e.type === 'user/message') return d.id === messageId
      if (e.type === 'agent/inbox/spliced') return (d.inserted || []).some((m) => m?.id === messageId)
      return false
    })
  }
  async ensure(binding, cwd) {
    if (binding?.session_id) {
      try { const s = await this.inspect(binding.session_id); if (s.meta.id !== binding.session_id) throw fail('harness-session-mismatch'); return { session_id: binding.session_id } }
      catch (e) { if (!missing(e)) throw e }
    }
    const r = await this.invoke('create', { cwd })
    if (!r.sessionId) throw fail('harness-invalid-session')
    await this.invoke('rename', { sessionId: r.sessionId, title: 'Agent Hub 从机会话' })
    await this.ctx.sessionPersistence.flush()
    return { session_id: r.sessionId }
  }
  async agent(id) {
    const live = this.ctx.agents.get(id); if (live) return live
    const resolved = await this.ctx.sessionController.resolveAgent(id)
    if (resolved.error) throw resolved.error
    const agent = resolved.agent || resolved
    if (typeof agent.followup !== 'function') throw fail('harness-agent-unavailable')
    return agent
  }
  async isIdle(id) {
    const agent = this.ctx.agents.get(id)
    if (agent) return agent.status !== 'running' && !this.active.has(id)
    await this.inspect(id) // Prove the Session exists before scheduling a wakeup.
    return true
  }
  async enqueue(task, { messageId = randomUUID(), beforeSubmit } = {}) {
    const agent = await this.agent(task.session_id)
    if (agent.status === 'running' || this.active.has(task.session_id)) return { queued: false, reason: 'master-busy' }
    if (await this.landed(task.session_id, messageId)) return { queued: true, message_id: messageId }
    await beforeSubmit?.(messageId)
    // No await between this check and followup: never splice a result reminder into a user's turn.
    if (agent.status === 'running' || this.active.has(task.session_id)) return { queued: false, reason: 'master-busy' }
    agent.followup(Object.freeze({ id: messageId, role: 'user', source: SOURCE, content: Object.freeze([Object.freeze({ type: 'text', text: task.prompt })]) }))
    await this.ctx.sessionPersistence.flush()
    return { queued: true, message_id: messageId }
  }
  async run(task, hooks = {}, options = {}) {
    const agent = await this.agent(task.session_id)
    if (this.active.has(task.session_id)) throw fail('harness-session-busy')
    const guidance = task.runtime === 'harness' ? '\n\n【执行约定】本任务由当前 Harness 固定会话负责。若用户要求使用 Codex，通过本机配置的 sub agent 调用，等待其明确完成并核查结果后再给出最终答复。若本机没有可用的 Codex sub agent 或调用工具，请明确报告阻塞原因，不要伪称已调用。遵守本机权限和用户审批；最终答复包含结论、验证摘要和本机产物路径，勿附完整对话、思考或原始命令输出。' : ''
    const prompt = `【Agent Hub task=${task.id}】\n${task.prompt}${guidance}`
    let resolve, reject
    const done = new Promise((ok, bad) => { resolve = ok; reject = bad })
    const entry = { task, hooks, resolve, reject, turn: null, prompt, answer: '', finalStep: -1, messageId: options.messageId || randomUUID() }
    this.active.set(task.session_id, entry)
    const message = Object.freeze({ id: entry.messageId, role: 'user', content: Object.freeze([Object.freeze({ type: 'text', text: prompt })]), source: SOURCE })
    try {
      // A stable message id is persisted by the caller before enqueue. A retry first inspects history.
      await options.beforeSubmit?.(entry.messageId)
      agent.followup(message)
      return await done
    } catch (e) { if (this.active.get(task.session_id) === entry) this.active.delete(task.session_id); throw e }
  }
  event(session, event) {
    const id = session.id ?? session.header?.id; const a = this.active.get(id)
    if (!a) return
    const d = event.data || {}
    if (event.type === 'turn/start') a.openTurn = d.turn
    if (event.type === 'user/message' && d.source?.kind === SOURCE_KIND && text(d.content) === a.prompt) {
      a.turn = d.turn ?? a.openTurn; a.hooks.started?.(String(a.turn)); return
    }
    if (a.turn === null || (d.turn !== undefined && String(d.turn) !== String(a.turn))) return
    if (event.type === 'tool/call') { a.answer = ''; a.finalStep = -1 }
    if (event.type === 'assistant/message') {
      const content = d.message?.content || []
      if (content.some((b) => b.type === 'tool-call')) { a.answer = ''; a.finalStep = -1 }
      else if ((d.step ?? 0) >= a.finalStep) { a.answer = text(content); a.finalStep = d.step ?? 0 }
    }
    if (event.type === 'turn/end' && String(d.turn) === String(a.turn)) {
      this.active.delete(id)
      const reason = typeof d.reason === 'string' ? d.reason : d.reason?.kind
      const status = reason === 'completed' ? 'completed' : ['user', 'cancelled', 'interrupted', 'disposed'].includes(reason) ? 'interrupted' : 'failed'
      this.ctx.sessionPersistence.flush().then(() => a.resolve({ status, answer: a.answer, ...(status === 'failed' ? { reason: 'harness-turn-failed' } : {}) }), a.reject)
      for (const [key, i] of this.interactions) if (i.taskId === a.task.id) { i.settle(null); a.hooks.resolved?.(key) }
    }
  }
  owned(req) { const id = req.agent?.session?.id ?? req.agent?.id; return this.active.get(id) }
  approval(req, next) {
    const a = this.owned(req); if (!a || a.turn === null || !a.hooks.interaction) return next()
    const events = req.agent.session.snapshotEvents?.() || req.agent.session.events || []
    const asked = [...events].reverse().find((e) => e.type === 'approval/asked' && e.data.callId === req.callId)
    const call = [...events].reverse().find((e) => e.type === 'tool/call' && (e.data.callId === req.callId || e.data.id === req.callId))
    if (!asked || !call || typeof req.toolName !== 'string') return next()
    let args
    try { args = typeof call.data.arguments === 'string' ? JSON.parse(call.data.arguments) : call.data.arguments } catch { return Promise.resolve('rejected') }
    const id = String(asked.data.id)
    return this.waitInteraction(a, id, req.signal, { kind: 'approval', interaction_id: id, tool_name: req.toolName, arguments: args || {} }, (answer) => answer || 'cancelled')
  }
  question(req, next) {
    const a = this.owned(req); if (!a || a.turn === null || !a.hooks.interaction) return next()
    const id = randomUUID()
    return this.waitInteraction(a, id, req.signal, { kind: 'question', interaction_id: id, questions: req.questions }, (answer) => {
      if (!answer) throw fail('ASK_CANCELLED')
      return answer
    })
  }
  waitInteraction(a, id, signal, value, convert) {
    return new Promise((resolve, reject) => {
      const abort = () => settle(null)
      const settle = (answer) => {
        if (!this.interactions.delete(id)) return
        signal?.removeEventListener('abort', abort)
        try { resolve(convert(answer)) } catch (e) { reject(e) }
        a.hooks.resolved?.(id)
      }
      this.interactions.set(id, { taskId: a.task.id, settle })
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) settle(null)
      else a.hooks.interaction?.(value)
    })
  }
  async decision(task, interaction, answer) {
    const pending = this.interactions.get(interaction.native_id)
    if (!pending || pending.taskId !== task.id) throw fail('interaction-not-pending')
    pending.settle(answer)
  }
  async cancel(task) {
    const a = this.active.get(task.session_id)
    if (!a || a.task.id !== task.id || String(a.turn) !== String(task.native_turn_id)) throw fail('unknown-native-turn')
    const agent = this.ctx.agents.get(task.session_id)
    if (!agent) throw fail('harness-unavailable')
    agent.cancel({ kind: 'user' }, { keepInbox: true })
  }
  async reconcile(task) {
    const s = await this.inspect(task.session_id)
    const events = s.events || []
    let turn = task.native_turn_id; let openTurn; let answer = ''; let ended
    for (const e of events) {
      const d = e.data || {}
      if (e.type === 'turn/start') openTurn = d.turn
      if (!turn && e.type === 'user/message' && [SOURCE_KIND, 'plugin:dsh-agent-hub-v2'].includes(d.source?.kind) && text(d.content).startsWith(`【Agent Hub task=${task.id}】\n`)) turn = d.turn ?? openTurn
      if (turn === null || turn === undefined || (d.turn !== undefined && String(d.turn) !== String(turn))) continue
      if (e.type === 'tool/call') answer = ''
      if (e.type === 'assistant/message') answer = (d.message?.content || []).some((b) => b.type === 'tool-call') ? '' : text(d.message?.content)
      if (e.type === 'turn/end' && String(d.turn) === String(turn)) ended = typeof d.reason === 'string' ? d.reason : d.reason?.kind
    }
    if (!ended) return null
    return { status: ended === 'completed' ? 'completed' : 'interrupted', answer }
  }
  close() {
    for (const dispose of this.disposers) dispose?.()
    for (const p of this.interactions.values()) p.settle(null)
    for (const a of this.active.values()) a.reject(fail('harness-host-disposed'))
    this.active.clear(); this.peer?.dispose?.()
  }
}
