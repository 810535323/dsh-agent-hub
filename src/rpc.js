import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { fail } from './util.js'

export class Rpc extends EventEmitter {
  constructor(send, { timeout = 30000 } = {}) { super(); this.sendRaw = send; this.pending = new Map(); this.timeout = timeout }
  request(method, params, timeout = this.timeout) {
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(fail('rpc-timeout')) }, timeout)
      this.pending.set(id, { resolve, reject, timer })
      try { this.sendRaw({ jsonrpc: '2.0', id, method, params }) } catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e) }
    })
  }
  notify(method, params) { this.sendRaw({ jsonrpc: '2.0', method, params }) }
  respond(id, result, error) { this.sendRaw(error ? { jsonrpc: '2.0', id, error: { code: -32000, message: error.code || 'operation-failed' } } : { jsonrpc: '2.0', id, result }) }
  receive(m) {
    if (m.method) { this.emit(m.id !== undefined ? 'request' : 'notification', m); return }
    const p = this.pending.get(m.id)
    if (!p) return
    clearTimeout(p.timer); this.pending.delete(m.id)
    if (m.error) p.reject(Object.assign(fail(m.error.data?.code || m.error.message || 'rpc-error'), { rpcError: m.error }))
    else p.resolve(m.result)
  }
  close() {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(fail('rpc-disconnected')) }
    this.pending.clear(); this.emit('disconnected')
  }
}
