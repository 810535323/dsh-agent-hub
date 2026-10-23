import { EventEmitter } from 'node:events'
import { fail } from '../util.js'

// Worker-side endpoint. Native Harness objects never cross this local boundary.
export class HarnessBridge extends EventEmitter {
  constructor() { super(); this.active = new Map() }
  attach(rpc) {
    this.rpc = rpc
    rpc.on('notification', (m) => {
      const p = m.params
      const active = p && this.active.get(p.task_id)
      if (!active) return
      if (m.method === 'runtime.started') active.hooks.started(p.native_turn_id)
      if (m.method === 'runtime.interaction') active.hooks.interaction(p.interaction)
      if (m.method === 'runtime.interaction-resolved') active.hooks.resolved(p.interaction_id)
    })
    rpc.once('disconnected', () => { if (this.rpc === rpc) this.rpc = null; this.emit('unavailable') })
    this.emit('available')
  }
  async ensure(binding, cwd) {
    if (!this.rpc) throw fail('harness-unavailable')
    return this.rpc.request('session.ensure', { session_id: binding?.session_id, cwd })
  }
  async bindSession(sessionId, cwd) {
    if (!this.rpc) throw fail('harness-unavailable')
    return this.rpc.request(sessionId ? 'session.validate' : 'session.ensure', { session_id: sessionId || undefined, cwd })
  }
  async run(task, hooks) {
    if (!this.rpc) throw fail('harness-unavailable')
    this.active.set(task.id, { hooks })
    try { return await this.rpc.request('task.run', task, 24 * 60 * 60 * 1000) }
    finally { this.active.delete(task.id) }
  }
  async cancel(task) { if (!this.rpc) throw fail('harness-unavailable'); return this.rpc.request('task.cancel', { task_id: task.id, session_id: task.session_id, native_turn_id: task.native_turn_id }) }
  async decision(task, interaction, answer) { if (!this.rpc) throw fail('harness-unavailable'); return this.rpc.request('task.decision', { task_id: task.id, interaction_id: interaction.native_id, answer }) }
  async reconcile(task) { if (!this.rpc) return null; return this.rpc.request('task.reconcile', task) }
  async close() { this.rpc?.close() }
}
