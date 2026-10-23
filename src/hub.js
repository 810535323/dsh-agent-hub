import http from 'node:http'
import https from 'node:https'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { WebSocketServer, WebSocket } from 'ws'
import { Store } from './store.js'
import { frame, parseFrame, MAX_FRAME, matchesTask, taskFields, TERMINAL, resultOnly } from './protocol.js'
import { secret, digest, sameSecret, fail, now, requireText } from './util.js'
import { isLoopback } from './transport.js'
import { serveRelease } from './releases.js'
import { ensureTaskNotice } from './reports.js'

async function body(req) {
  const chunks = []; let bytes = 0
  for await (const c of req) { bytes += c.length; if (bytes > MAX_FRAME) throw fail('body-too-large'); chunks.push(c) }
  return JSON.parse(Buffer.concat(chunks).toString() || '{}')
}
const reply = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)) }

export class Hub {
  constructor({ dbPath, adminToken, host = '127.0.0.1', port = 9444, tls, releaseDir, allowInsecure = false, onMailbox = () => {} }) {
    // Read and validate certificate files before opening the task database.
    const listener = (req, res) => this.handleHttp(req, res).catch((e) => {
      if (res.headersSent || res.destroyed) { res.destroy(); return }
      reply(res, e.code === 'offline' ? 409 : 400, { ok: false, error: e.code || 'request-failed' })
    })
    this.server = tls
      ? https.createServer({ cert: readFileSync(tls.certFile), key: readFileSync(tls.keyFile), minVersion: 'TLSv1.2' }, listener)
      : http.createServer(listener)
    this.store = new Store(dbPath); this.adminToken = adminToken; this.host = host; this.port = port
    this.releaseDir = releaseDir
    this.allowInsecure = allowInsecure; this.onMailbox = onMailbox; this.connections = new Map()
    for (const task of this.store.all('tasks').filter((t) => !TERMINAL.has(t.status))) {
      this.store.put('tasks', { ...task, status: 'uncertain', connection_lost: true, reason: 'hub-restarted-awaiting-worker' })
    }
    this.wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME })
    this.server.on('upgrade', (req, socket, head) => this.upgrade(req, socket, head))
  }
  async listen() {
    await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(this.port, this.host, resolve) })
    this.timer = setInterval(() => {
      for (const c of this.connections.values()) {
        if (Date.now() - c.lastSeen > 45000) { c.ws.terminate(); continue }
        c.ws.ping(); this.flush(c)
      }
      this.notify()
    }, 1000)
    this.timer.unref()
    return this
  }
  notify() { try { Promise.resolve(this.onMailbox()).catch(() => {}) } catch {} }
  bindMaster({ session_id, bot_id, target_id }) {
    for (const [k, v] of Object.entries({ session_id, bot_id, target_id })) requireText(v, k, 256)
    return this.store.put('masters', { id: session_id, session_id, bot_id, target_id })
  }
  createPair(masterId) {
    if (!this.store.get('masters', masterId)) throw fail('master-not-bound')
    const code = secret().slice(0, 12).toUpperCase()
    const record = { id: digest(code), public_id: randomUUID(), master_id: masterId, expires_at: Date.now() + 300000, created_at: now() }
    this.store.transaction(() => { this.store.put('pairs', record); this.store.put('pair_history', record) })
    return { code, expires_in: 300, created_at: record.created_at, pair_id: record.public_id }
  }
  enroll({ code, name }) {
    requireText(code, 'code', 128); requireText(name, 'name', 100)
    const pair = this.store.get('pairs', digest(code))
    if (!pair || pair.expires_at < Date.now()) throw fail('invalid-pair-code')
    const id = 'dev_' + randomUUID(); const token = secret()
    this.store.transaction(() => {
      this.store.put('devices', { id, name, token_hash: digest(token), master_id: pair.master_id, created_at: now() })
      this.store.put('pair_history', { ...pair, used_at: now() })
      this.store.remove('pairs', pair.id)
    })
    return { device_id: id, token }
  }
  listDevices(masterId) {
    return this.store.all('devices').filter((d) => !d.revoked_at && (!masterId || d.master_id === masterId)).map(({ token_hash, ...d }) => ({
      ...d, last_seen_at: this.connections.get(d.id)?.lastSeen ? new Date(this.connections.get(d.id).lastSeen).toISOString() : d.last_seen_at || null, online: this.isOnline(d.id), endpoints: this.store.all('endpoints').filter((e) => e.device_id === d.id && e.runtime === 'harness').map((e) => ({ ...e, ready: this.isOnline(d.id) && e.ready })),
    }))
  }
  unpairDevice(masterId, deviceId) {
    const device = this.store.get('devices', deviceId)
    if (!device || device.master_id !== masterId) throw fail('unknown-device')
    const previous = this.store.get('device_revocations', deviceId)
    if (previous) return previous
    if (this.store.all('tasks').some((t) => t.device_id === deviceId && !TERMINAL.has(t.status))) throw fail('runtime-has-active-tasks')
    const receipt = { id: deviceId, device_id: deviceId, receipt_id: randomUUID(), revoked_at: now() }
    this.store.transaction(() => {
      this.store.put('devices', { ...device, revoked_at: receipt.revoked_at })
      this.store.put('device_revocations', receipt)
      for (const e of this.store.all('endpoints').filter((e) => e.device_id === deviceId)) this.store.put('endpoints', { ...e, ready: false })
    })
    const connection = this.connections.get(deviceId)
    this.connections.delete(deviceId)
    connection?.ws.close(4003, 'device unpaired')
    return receipt
  }
  isOnline(id) { const c = this.connections.get(id); return !!c && c.ready && c.ws.readyState === WebSocket.OPEN && Date.now() - c.lastSeen < 45000 }
  dispatch(masterId, { endpoint_id, prompt }) {
    requireText(prompt, 'prompt', 65536)
    const endpoint = this.store.get('endpoints', endpoint_id)
    const device = endpoint && this.store.get('devices', endpoint.device_id)
    if (!device || device.revoked_at || device.master_id !== masterId) throw fail('unknown-endpoint')
    if (endpoint.runtime !== 'harness') throw fail('harness-only-use-local-subagent')
    if (!this.isOnline(device.id) || !endpoint.ready) throw fail('offline')
    const task = {
      id: 'task_' + randomUUID(), attempt_id: randomUUID(), master_id: masterId, device_id: device.id,
      endpoint_id, runtime: endpoint.runtime, session_id: endpoint.session_id, binding_version: endpoint.binding_version,
      prompt, status: 'dispatched', created_at: now(), business_outcome: 'unassessed',
    }
    this.store.transaction(() => {
      this.store.put('tasks', task)
      this.store.enqueue(frame('task.dispatch', { runtime: task.runtime, session_id: task.session_id, prompt }, taskFields(task)))
    })
    this.flush(this.connections.get(device.id))
    return this.publicTask(task)
  }
  publicTask(task) { const { prompt, ...safe } = task; return safe }
  task(masterId, id) {
    const task = this.store.get('tasks', id)
    if (!task || task.master_id !== masterId) throw fail('unknown-task')
    return this.publicTask(task)
  }
  cancel(masterId, id) {
    const task = this.store.get('tasks', id)
    if (!task || task.master_id !== masterId) throw fail('unknown-task')
    if (TERMINAL.has(task.status)) return this.publicTask(task)
    task.cancel_requested = true
    this.store.transaction(() => { this.store.put('tasks', task); this.store.enqueue(frame('task.cancel', {}, taskFields(task))) })
    this.flush(this.connections.get(task.device_id))
    return this.publicTask(task)
  }
  decision(interactionId, answer) {
    const interaction = this.store.get('interactions', interactionId)
    if (!interaction || interaction.resolved || interaction.decision_pending || interaction.expires_at < Date.now()) throw fail('interaction-not-pending')
    const task = this.store.get('tasks', interaction.task_id)
    if (!task || TERMINAL.has(task.status)) throw fail('interaction-not-pending')
    if (interaction.kind === 'approval' && !['allowed-once', 'rejected'].includes(answer)) throw fail('invalid-decision')
    if (interaction.kind === 'question' && (!answer || !Array.isArray(answer.answers))) throw fail('invalid-answer')
    this.store.transaction(() => {
      this.store.put('interactions', { ...interaction, decision: answer, decision_pending: true })
      this.store.enqueue(frame('task.decision', { interaction_id: interactionId, answer }, taskFields(task)))
    })
    this.flush(this.connections.get(task.device_id))
  }
  upgrade(req, socket, head) {
    const url = new URL(req.url, 'http://localhost')
    const reject = () => { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n') }
    if (url.pathname !== '/v2/worker') return reject()
    if (!this.allowInsecure && !req.socket.encrypted && !isLoopback(req.socket.remoteAddress)) return reject()
    const device = this.store.get('devices', url.searchParams.get('device_id'))
    const token = String(req.headers.authorization || '').replace(/^Bearer /, '')
    if (!device || device.revoked_at || !sameSecret(digest(token), device.token_hash)) return reject()
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.connections.get(device.id)?.ws.close(4001, 'replaced')
      const c = { ws, device, ready: false, lastSeen: Date.now() }
      this.connections.set(device.id, c)
      ws.on('pong', () => { c.lastSeen = Date.now() })
      ws.on('error', () => {})
      ws.on('message', (raw) => {
        if (this.connections.get(device.id) !== c) return
        try { this.handleMessage(c, parseFrame(raw)) } catch { ws.close(4002, 'invalid message or storage unavailable') }
      })
      ws.on('close', () => {
        if (this.connections.get(device.id) !== c) return
        this.connections.delete(device.id)
        this.store.put('devices', { ...this.store.get('devices', device.id), last_seen_at: now() })
        for (const t of this.store.all('tasks').filter((t) => t.device_id === device.id && !TERMINAL.has(t.status))) {
          this.store.put('tasks', { ...t, connection_lost: true, disconnected_at: now() })
        }
      })
    })
  }
  handleMessage(c, m) {
    c.lastSeen = Date.now()
    if (m.type === 'hello') {
      if (!Array.isArray(m.payload.endpoints) || m.payload.endpoints.length > 2) throw fail('invalid-endpoints')
      this.store.transaction(() => {
        for (const old of this.store.all('endpoints').filter((e) => e.device_id === c.device.id)) this.store.put('endpoints', { ...old, ready: false })
        for (const e of m.payload.endpoints) {
          if (!['codex', 'harness'].includes(e.runtime) || !Number.isSafeInteger(e.binding_version) || e.binding_version < 1) throw fail('invalid-endpoint')
          if (e.ready === true) requireText(e.session_id, 'session', 256)
          const id = c.device.id + ':' + e.runtime
          const previous = this.store.get('endpoints', id)
          if (previous && (e.binding_version < previous.binding_version || (e.binding_version === previous.binding_version && previous.session_id && previous.session_id !== e.session_id))) throw fail('stale-binding')
          this.store.put('endpoints', { id, device_id: c.device.id, runtime: e.runtime, session_id: e.session_id || null, binding_version: e.binding_version, ready: e.runtime === 'harness' && e.ready === true, context_reset: e.context_reset === true, unavailable_reason: e.runtime !== 'harness' ? 'harness-only-use-local-subagent' : typeof e.unavailable_reason === 'string' && /^[a-zA-Z0-9_/-]{1,100}$/.test(e.unavailable_reason) ? e.unavailable_reason : null })
        }
      })
      c.ready = true; c.ws.send(JSON.stringify(frame('hello.ready')))
      // A task dispatch never waits in the Hub for an offline device to reconnect.
      for (const pending of this.store.pending().filter((p) => p.type === 'task.dispatch')) {
        const t = this.store.get('tasks', pending.task_id)
        if (t?.device_id === c.device.id && t.connection_lost) {
          this.store.put('tasks', { ...t, status: 'uncertain', reason: 'dispatch-requires-reconciliation' })
          continue
        }
      }
      this.flush(c); return
    }
    if (!c.ready) throw fail('hello-required')
    if (m.type === 'connection.check') {
      requireText(m.payload.nonce, 'nonce', 100)
      c.ws.send(JSON.stringify(frame('connection.checked', { nonce: m.payload.nonce, device_id: c.device.id }))); return
    }
    const task = this.store.get('tasks', m.task_id)
    if (!matchesTask(task, m) || task.device_id !== c.device.id) throw fail('task-mismatch')
    if (m.type === 'ack') {
      const pending = this.store.pending().find((x) => x.message_id === m.payload.ack_id)
      if (this.store.acknowledge(m) && pending?.type === 'task.decision') {
        const i = this.store.get('interactions', pending.payload.interaction_id)
        if (i) this.store.put('interactions', { ...i, resolved: true, decision_pending: false })
      }
      return
    }
    const previous = this.store.receipt(m.message_id)
    if (previous) { if (!matchesTask(task, previous)) throw fail('receipt-mismatch'); c.ws.send(JSON.stringify(previous)); return }
    const ack = frame('ack', { ack_id: m.message_id, persisted: true, received_at: now() }, taskFields(task))
    this.store.transaction(() => {
      if (m.type === 'task.state') {
        if (!['accepted', 'starting', 'running', 'uncertain'].includes(m.payload.status)) throw fail('invalid-task-state')
        const rank = { dispatched: 0, accepted: 1, starting: 2, running: 3, uncertain: 4 }
        if (!TERMINAL.has(task.status) && (rank[m.payload.status] >= (rank[task.status] ?? 0) || (task.status === 'uncertain' && m.payload.status === 'running' && m.payload.native_turn_id))) {
          this.store.put('tasks', { ...task, status: m.payload.status, connection_lost: false, native_turn_id: typeof m.payload.native_turn_id === 'string' ? m.payload.native_turn_id : task.native_turn_id })
          if (m.payload.status === 'uncertain' && (!this.store.get('mailbox', task.id) || task.status !== 'uncertain')) this.store.put('mailbox', { id: task.id, task_id: task.id, master_id: task.master_id, state: 'pending', created_at: now() })
        }
      } else if (m.type === 'task.result') {
        if (!TERMINAL.has(task.status)) {
          const result = resultOnly(m.payload)
          result.artifacts = result.artifacts.map((a) => ({ ...a, device_id: task.device_id }))
          const finished = { ...task, status: result.status, result, result_message_id: m.message_id, finished_at: now(), connection_lost: false }
          this.store.put('tasks', finished)
          this.store.put('mailbox', { id: task.id, task_id: task.id, master_id: task.master_id, state: 'pending', revision: m.message_id, created_at: now() })
          ensureTaskNotice(this.store, finished)
          for (const i of this.store.all('interactions').filter((i) => i.task_id === task.id && !i.resolved)) this.store.put('interactions', { ...i, resolved: true })
        }
      } else if (m.type === 'task.interaction') {
        if (!TERMINAL.has(task.status)) {
          const p = m.payload
          if (!['approval', 'question'].includes(p.kind)) throw fail('invalid-interaction')
          requireText(p.interaction_id, 'interaction-id', 200)
          const id = task.id + ':' + p.interaction_id
          if (!this.store.get('interactions', id)) {
            const interaction = { id, native_id: p.interaction_id, task_id: task.id, master_id: task.master_id, kind: p.kind, expires_at: Date.now() + 3600000, resolved: false }
            if (p.kind === 'approval') {
              interaction.tool_name = requireText(p.tool_name, 'tool-name', 200)
              if (!p.arguments || typeof p.arguments !== 'object' || Buffer.byteLength(JSON.stringify(p.arguments)) > 12000) throw fail('invalid-approval-arguments')
              interaction.arguments = p.arguments
            } else {
              if (!Array.isArray(p.questions) || p.questions.length < 1 || p.questions.length > 5) throw fail('invalid-questions')
              interaction.questions = p.questions.map((q) => ({ id: requireText(q.id, 'question-id', 100), question: requireText(q.question, 'question', 3000), options: Array.isArray(q.options) ? q.options.slice(0, 10).map((o) => ({ label: requireText(o.label, 'option', 300), description: typeof o.description === 'string' ? o.description.slice(0, 1000) : '' })) : [], multiSelect: q.multiSelect === true }))
            }
            this.store.put('interactions', interaction)
            this.store.put('tasks', { ...task, status: p.kind === 'approval' ? 'waiting_approval' : 'waiting_input' })
          }
        }
      } else if (m.type === 'task.interaction-resolved') {
        const id = task.id + ':' + m.payload.interaction_id; const i = this.store.get('interactions', id)
        if (i) this.store.put('interactions', { ...i, resolved: true })
        if (!TERMINAL.has(task.status)) this.store.put('tasks', { ...task, status: 'running' })
      } else throw fail('unknown-message')
      this.store.received(m, ack)
    })
    c.ws.send(JSON.stringify(ack)); this.notify()
  }
  flush(c) {
    if (!c || !c.ready || c.ws.readyState !== WebSocket.OPEN) return
    for (const m of this.store.pending()) {
      const task = this.store.get('tasks', m.task_id)
      if (task?.device_id !== c.device.id) continue
      if (m.type === 'task.dispatch' && (task.runtime !== 'harness' || task.connection_lost || task.status !== 'dispatched')) continue
      c.ws.send(JSON.stringify(m))
    }
  }
  async handleHttp(req, res) {
    const u = new URL(req.url, 'http://localhost')
    if (req.method === 'GET' && u.pathname === '/health') return reply(res, 200, { ok: true, protocol: 2, version: 'latest', runtime: 'harness' })
    if (this.releaseDir && await serveRelease(req, res, this.releaseDir)) return
    if (!this.allowInsecure && !req.socket.encrypted && !isLoopback(req.socket.remoteAddress)) return reply(res, 403, { ok: false, error: 'https-required' })
    if (req.method === 'POST' && u.pathname === '/v2/enroll') return reply(res, 200, { ok: true, ...this.enroll(await body(req)) })
    if (req.method === 'POST' && u.pathname === '/v2/device/unpair') {
      const input = await body(req), device = this.store.get('devices', input.device_id)
      const token = String(req.headers.authorization || '').replace(/^Bearer /, '')
      if (!device || !sameSecret(digest(token), device.token_hash)) return reply(res, 401, { ok: false, error: 'unauthorized' })
      // A revoked token can only retrieve the same durable revocation receipt.
      return reply(res, 200, { ok: true, receipt: this.unpairDevice(device.master_id, device.id) })
    }
    // Direct public listeners expose enrollment and worker transport; management stays local.
    if (!isLoopback(req.socket.remoteAddress)) return reply(res, 403, { ok: false, error: 'local-admin-only' })
    if (!this.adminToken || !sameSecret(String(req.headers.authorization || ''), 'Bearer ' + this.adminToken)) return reply(res, 401, { ok: false })
    const b = req.method === 'POST' ? await body(req) : {}
    if (req.method === 'POST' && u.pathname === '/v2/master') return reply(res, 200, { ok: true, master: this.bindMaster(b) })
    if (req.method === 'POST' && u.pathname === '/v2/pair') return reply(res, 200, { ok: true, ...this.createPair(b.master_id) })
    if (req.method === 'GET' && u.pathname === '/v2/devices') return reply(res, 200, { ok: true, devices: this.listDevices(u.searchParams.get('master_id')) })
    return reply(res, 404, { ok: false, error: 'not-found' })
  }
  async close() {
    this.closing = true
    clearInterval(this.timer)
    const connections = [...this.connections.values()]
    this.connections.clear()
    for (const c of connections) c.ws.terminate()
    await new Promise((r) => this.wss.close(r))
    await new Promise((r) => this.server.close(r))
    this.store.close()
  }
}
