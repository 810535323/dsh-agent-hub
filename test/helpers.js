import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'
import { after } from 'node:test'

const temporaryDirectories = []
after(async () => {
  for (const dir of temporaryDirectories) {
    const base = resolve(tmpdir())
    assert.ok(resolve(dir).startsWith(base + sep + 'agent-hub-test-'))
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

export function temp(t) {
  const base = resolve(tmpdir()); const dir = mkdtempSync(join(base, 'agent-hub-test-'))
  temporaryDirectories.push(dir)
  return dir
}
export async function until(check, timeout = 5000) {
  const stop = Date.now() + timeout
  while (Date.now() < stop) { const result = await check(); if (result) return result; await new Promise((r) => setTimeout(r, 15)) }
  throw new Error('Condition did not become true')
}
export function autoReply(ctx, text) {
  const original = ctx.makeSession.bind(ctx)
  ctx.makeSession = (id) => {
    const session = original(id)
    ctx.agents.get(session.id).followup = (message) => setImmediate(() => {
      const turn = session.events.length + 1
      ctx.event(session.id, 'turn/start', { turn })
      ctx.event(session.id, 'user/message', { turn, source: message.source, content: message.content })
      ctx.event(session.id, 'assistant/message', { turn, step: 0, message: { content: [{ type: 'text', text }] } })
      ctx.event(session.id, 'turn/end', { turn, reason: 'completed' })
    })
    return session
  }
}
export class FakeAdapter {
  constructor() { this.id = randomUUID(); this.runs = []; this.pending = new Map(); this.results = new Map(); this.deleted = false }
  async ensure(binding) { if (this.error) throw this.error; if (this.deleted) { this.id = randomUUID(); this.deleted = false }; return { session_id: binding && !this.reset ? binding.session_id : this.id } }
  async run(task, hooks) {
    this.runs.push(task); hooks.started('turn-' + task.id)
    return new Promise((resolve) => this.pending.set(task.id, { resolve, hooks }))
  }
  finish(id, result = { status: 'completed', answer: '最终结果' }) { this.results.set(id, result); this.pending.get(id)?.resolve(result); this.pending.delete(id) }
  async reconcile(task) { return this.results.get(task.id) || null }
  async cancel(task) { this.finish(task.id, { status: 'interrupted', answer: '' }) }
  async decision(task, interaction, answer) { this.lastDecision = { task, interaction, answer }; this.pending.get(task.id)?.hooks.resolved(interaction.native_id) }
  async close() { for (const id of this.pending.keys()) this.finish(id, { status: 'interrupted' }) }
}
export class FakeHarnessContext extends EventEmitter {
  constructor() {
    super(); this.nativeSessions = new Map(); this.nativeAgents = new Map(); this.disposers = []
    this.agents = { get: (id) => this.nativeAgents.get(id) }
    this.sessionPersistence = { flush: async () => {} }
    this.sessionController = {
      inspect: async (id) => { const s = this.nativeSessions.get(id); if (!s) throw Object.assign(new Error(), { code: 'session/not-found' }); return { meta: { id }, events: s.events } },
      resolveAgent: async (id) => { const agent = this.nativeAgents.get(id); return agent ? { agent } : { error: Object.assign(new Error(), { code: 'session/not-found' }) } },
    }
    this.typertGateway = { invoke: async ({ method, args }) => {
      if (method === 'create') { const session = this.makeSession(); return { sessionId: session.id } }
      if (method === 'rename') return {}
      throw new Error('Unexpected native method ' + method)
    } }
    this.connection = { createPeer: () => ({ dispose() {} }) }
  }
  on(name, listener) { super.on(name, listener); return () => super.off(name, listener) }
  effect(fn) { const d = fn(); if (typeof d === 'function') this.disposers.push(d) }
  makeSession(id = randomUUID()) {
    const session = { id, header: { id }, events: [], snapshotEvents() { return this.events } }
    this.nativeSessions.set(id, session)
    this.nativeAgents.set(id, { id, session, followup: (m) => { this.submitted = { id, message: m } }, cancel() {} })
    return session
  }
  event(id, type, data) { const session = this.nativeSessions.get(id); const e = { seq: session.events.length, type, data }; session.events.push(e); this.emit('session/event', session, e) }
}
