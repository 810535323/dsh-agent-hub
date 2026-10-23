import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { WebSocket, WebSocketServer } from 'ws'
import { Store } from './store.js'
import { Rpc } from './rpc.js'
import { frame, parseFrame, MAX_FRAME, TERMINAL, matchesTask, taskFields, resultOnly } from './protocol.js'
import { sameSecret, now, fail, safeError, sleep, writeConfig } from './util.js'
import { join } from 'node:path'
import { clientTLS } from './transport.js'
import { requestUnpair, finishUnpair } from './unpair.js'

export class Worker {
  constructor({ dbPath, config, adapters, localPort = 9451, home, onUnpaired }) {
    if (Object.keys(adapters).some((runtime) => runtime !== 'harness')) throw fail('harness-only-use-local-subagent')
    this.home = home; this.onUnpaired = onUnpaired
    this.clientTLS = clientTLS(config)
    this.store = new Store(dbPath); this.config = config; this.adapters = adapters; this.localPort = localPort
    this.running = new Set(); this.refreshing = false; this.stopped = false; this.instance = randomUUID()
    this.executions = new Set(); this.controlsApplying = new Set()
    this.bindingChanges = new Set(); this.runtimeErrors = new Map(); this.checks = new Map()
    this.refreshingRuntimes = new Set()
    this.server = http.createServer((req, res) => this.handleControl(req, res).catch((e) => {
      res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: safeError(e) }))
    }))
    this.local = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME })
    this.server.on('upgrade', (req, socket, head) => {
      if (req.url !== '/harness' || !sameSecret(req.headers.authorization, 'Bearer ' + config.local_token) || !adapters.harness || this.harnessSocket?.readyState === WebSocket.OPEN) { socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n'); return }
      this.local.handleUpgrade(req, socket, head, (ws) => {
        this.harnessSocket = ws
        const rpc = new Rpc((m) => ws.send(JSON.stringify(m)))
        ws.on('message', (raw) => { try { rpc.receive(JSON.parse(String(raw))) } catch { ws.close() } })
        ws.on('error', () => {})
        ws.once('close', () => { rpc.close(); if (!this.stopped) { this.markUnavailable('harness'); this.announce() } })
        adapters.harness.attach(rpc); void this.refresh()
      })
    })
  }
  async start() {
    await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(this.localPort, '127.0.0.1', resolve) })
    for (const task of this.store.all('tasks').filter((t) => !TERMINAL.has(t.status))) {
      // Even accepted tasks are not replayed after a cold start without native evidence.
      this.store.put('tasks', { ...task, status: 'uncertain', reason: 'worker-restarted' })
      this.emitState({ ...task, status: 'uncertain' })
    }
    for (const binding of this.store.all('bindings')) this.markUnavailable(binding.id)
    void this.refresh(); this.connect()
    this.timer = setInterval(() => {
      this.flush(); void this.refresh(); this.schedule()
      for (const c of this.store.all('controls').filter((c) => c.state === 'pending')) void this.applyControl(c.id)
      for (const i of this.store.all('interactions').filter((i) => !i.resolved && i.expires_at < Date.now())) {
        const t = this.store.get('tasks', i.task_id)
        if (t && !TERMINAL.has(t.status)) {
          Promise.resolve(i.kind === 'approval' ? this.adapters[t.runtime].decision(t, i, 'rejected') : this.adapters[t.runtime].cancel(t)).then(() => this.resolveInteraction(t.id, i.native_id)).catch(() => {})
        }
      }
    }, 1000); this.timer.unref()
    return this
  }
  endpoints() {
    return Object.keys(this.adapters).map((runtime) => {
      const b = this.store.get('bindings', runtime)
      return { runtime, binding_version: b?.version || 1, session_id: b?.session_id || null, ready: b?.ready === true, context_reset: b?.context_reset === true, ...(this.runtimeErrors.has(runtime) ? { unavailable_reason: this.runtimeErrors.get(runtime) } : {}) }
    })
  }
  markUnavailable(runtime) { const b = this.store.get('bindings', runtime); if (b) this.store.put('bindings', { ...b, ready: false }) }
  async refresh() {
    if (this.stopped || this.unpairing || this.unpaired || this.revoked || this.replacing) return
    await Promise.all(Object.entries(this.adapters).map(async ([runtime, adapter]) => {
        if (this.running.has(runtime) || this.bindingChanges.has(runtime) || this.refreshingRuntimes.has(runtime)) return
        this.refreshingRuntimes.add(runtime); this.refreshing = true
        const before = this.store.get('bindings', runtime)
        try {
          const result = await adapter.ensure(before, this.config.cwd)
          if (typeof result?.session_id !== 'string' || !result.session_id) throw fail('invalid-session-identity')
          const changed = before?.session_id && before.session_id !== result.session_id
          if (this.stopped) return
          this.runtimeErrors.delete(runtime)
          if (changed) for (const t of this.store.all('tasks').filter((t) => t.runtime === runtime && t.status === 'accepted')) this.finish(t.id, { status: 'interrupted', reason: 'binding-replaced-before-start' })
          this.store.put('bindings', { id: runtime, session_id: result.session_id, version: changed ? before.version + 1 : before?.version || 1, ready: true, context_reset: !!changed || before?.context_reset === true })
          for (const task of this.store.all('tasks').filter((t) => t.runtime === runtime && t.status === 'uncertain')) {
            try {
              const result = await adapter.reconcile(task)
              if (result && TERMINAL.has(result.status)) this.finish(task.id, result)
            } catch {}
          }
        } catch (e) { this.runtimeErrors.set(runtime, safeError(e)); this.markUnavailable(runtime) }
        finally { this.refreshingRuntimes.delete(runtime); this.refreshing = this.refreshingRuntimes.size > 0; if (!this.stopped) this.announce() }
    }))
  }
  connect() {
    if (this.stopped || this.unpaired || this.revoked) return
    const url = new URL('/v2/worker', this.config.hub); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    url.searchParams.set('device_id', this.config.device_id)
    this.ws = new WebSocket(url, { ...this.clientTLS, headers: { Authorization: 'Bearer ' + this.config.token }, maxPayload: MAX_FRAME, handshakeTimeout: 10000 })
    this.ready = false
    this.ws.on('open', () => { this.connected_at = now(); this.connection_error = null; this.announce(true) })
    this.ws.on('error', (e) => { this.connection_error = safeError(e) })
    this.ws.on('message', (raw) => {
      if (this.stopped) return
      try { this.receive(parseFrame(raw)) } catch { this.ws.close(4002, 'invalid message or storage unavailable') }
    })
    this.ws.on('close', (code) => {
      this.ready = false
      for (const c of this.checks.values()) { clearTimeout(c.timer); c.reject(fail('offline')) }; this.checks.clear()
      if (this.stopped) return
      if (code === 4003) {
        this.revoked = true; this.connection_error = 'device-unpaired'
        if (this.home) void this.unpair().catch((e) => { this.connection_error = safeError(e) })
        return
      }
      // Unstarted work must not run merely because the device later comes online.
      for (const task of this.store.all('tasks').filter((t) => t.status === 'accepted')) this.finish(task.id, { status: 'interrupted', reason: 'disconnected-before-start' })
      if (!this.stopped && !this.unpaired && !this.revoked) this.reconnectTimer = setTimeout(() => this.connect(), 1500)
    })
  }
  announce(force = false) {
    if (this.ws?.readyState !== WebSocket.OPEN) return
    const endpoints = this.endpoints(); const signature = JSON.stringify(endpoints)
    if (force || signature !== this.lastAnnouncement) { this.lastAnnouncement = signature; this.ws.send(JSON.stringify(frame('hello', { instance_id: this.instance, endpoints }))) }
  }
  receive(m) {
    this.last_contact_at = now()
    if (m.type === 'connection.checked') {
      const check = this.checks.get(m.payload.nonce)
      if (check && m.payload.device_id === this.config.device_id) { clearTimeout(check.timer); this.checks.delete(m.payload.nonce); check.resolve({ connected: true, checked_at: now(), latency_ms: Date.now() - check.started }) }
      return
    }
    if (m.type === 'hello.ready') {
      this.ready = true
      for (const t of this.store.all('tasks').filter((t) => ['accepted', 'starting', 'running', 'uncertain'].includes(t.status))) this.emitState(t)
      this.flush(); this.schedule(); return
    }
    if (m.type === 'ack') { this.store.acknowledge(m); return }
    if (!['task.dispatch', 'task.cancel', 'task.decision'].includes(m.type)) throw fail('unknown-message')
    const oldReceipt = this.store.receipt(m.message_id)
    if (oldReceipt) { if (oldReceipt.task_id !== m.task_id || oldReceipt.attempt_id !== m.attempt_id) throw fail('receipt-mismatch'); this.send(oldReceipt); return }
    let task = this.store.get('tasks', m.task_id)
    const ack = frame('ack', { ack_id: m.message_id, persisted: true, received_at: now() }, { task_id: m.task_id, attempt_id: m.attempt_id, binding_version: m.binding_version })
    if (m.type === 'task.dispatch') {
      if (m.payload.runtime !== 'harness') throw fail('harness-only-use-local-subagent')
      const b = this.store.get('bindings', m.payload.runtime)
      if (!b?.ready || b.version !== m.binding_version || b.session_id !== m.payload.session_id) throw fail('binding-mismatch')
      if (task && !matchesTask(task, m)) throw fail('task-mismatch')
      this.store.transaction(() => {
        if (!task) {
          task = { id: m.task_id, attempt_id: m.attempt_id, binding_version: m.binding_version, runtime: m.payload.runtime, session_id: b.session_id, prompt: m.payload.prompt, status: 'accepted', created_at: now() }
          this.store.put('tasks', task); this.emitState(task)
        }
        this.store.received(m, ack)
      })
      this.send(ack); this.flush(); this.schedule(); return
    }
    if (!task && m.type === 'task.cancel') {
      task = { id: m.task_id, attempt_id: m.attempt_id, binding_version: m.binding_version, status: 'cancelled', reason: 'never-accepted' }
      this.store.transaction(() => {
        this.store.put('tasks', task); this.store.received(m, ack)
        this.store.enqueue(frame('task.result', { status: 'cancelled', reason: 'never-accepted' }, taskFields(task)))
      })
      this.send(ack); this.flush(); return
    }
    if (!matchesTask(task, m)) throw fail('task-mismatch')
    // Commit control intent before invoking native APIs; replay reconciles through local state.
    this.store.transaction(() => {
      this.store.put('controls', { id: m.message_id, type: m.type, task_id: task.id, payload: m.payload, state: 'pending' })
      this.store.received(m, ack)
    })
    this.send(ack); void this.applyControl(m.message_id)
  }
  async applyControl(id) {
    if (this.stopped || this.controlsApplying.has(id)) return
    const c = this.store.get('controls', id); if (!c || c.state !== 'pending') return
    const t = this.store.get('tasks', c.task_id); if (!t) return
    this.controlsApplying.add(id)
    try {
      if (c.type === 'task.cancel') {
        if (!TERMINAL.has(t.status)) {
          if (t.status !== 'accepted') await this.adapters[t.runtime].cancel(t)
          if (t.status === 'accepted') this.finish(t.id, { status: 'cancelled' })
        }
      } else if (!TERMINAL.has(t.status)) {
        const interaction = this.store.get('interactions', c.payload.interaction_id)
        if (interaction && !interaction.resolved && interaction.expires_at > Date.now()) {
          await this.adapters[t.runtime].decision(t, interaction, c.payload.answer)
          this.resolveInteraction(t.id, interaction.native_id)
        }
      }
      this.store.put('controls', { ...c, state: 'applied' })
    } catch { /* Keep a durable control request for reconciliation, never fabricate approval. */ }
    finally { this.controlsApplying.delete(id) }
  }
  emitState(task) { this.store.enqueue(frame('task.state', { status: task.status, ...(task.native_turn_id ? { native_turn_id: String(task.native_turn_id) } : {}) }, taskFields(task))) }
  update(id, fields) {
    const task = this.store.get('tasks', id); if (!task || TERMINAL.has(task.status)) return
    const next = { ...task, ...fields }
    this.store.transaction(() => { this.store.put('tasks', next); this.emitState(next) }); this.flush()
  }
  interaction(taskId, value) {
    const task = this.store.get('tasks', taskId); if (!task || TERMINAL.has(task.status)) return
    const interaction = { ...value, id: taskId + ':' + value.interaction_id, native_id: value.interaction_id, task_id: taskId, expires_at: Date.now() + 3600000, resolved: false }
    this.store.transaction(() => {
      this.store.put('interactions', interaction)
      this.store.put('tasks', { ...task, status: value.kind === 'approval' ? 'waiting_approval' : 'waiting_input' })
      this.store.enqueue(frame('task.interaction', value, taskFields(task)))
    }); this.flush()
  }
  resolveInteraction(taskId, nativeId) {
    const task = this.store.get('tasks', taskId); const interaction = this.store.get('interactions', taskId + ':' + nativeId)
    if (!task || !interaction || interaction.resolved) return
    this.store.transaction(() => {
      this.store.put('interactions', { ...interaction, resolved: true })
      if (!TERMINAL.has(task.status)) this.store.put('tasks', { ...task, status: 'running' })
      this.store.enqueue(frame('task.interaction-resolved', { interaction_id: nativeId }, taskFields(task)))
    }); this.flush()
  }
  finish(id, value) {
    const task = this.store.get('tasks', id); if (!task || TERMINAL.has(task.status)) return
    const result = resultOnly(value)
    this.store.transaction(() => {
      this.store.put('tasks', { ...task, status: result.status, result, finished_at: now() })
      this.store.enqueue(frame('task.result', result, taskFields(task)))
    }); this.flush()
  }
  schedule() {
    if (!this.ready || this.stopped || this.unpairing || this.unpaired || this.revoked || this.replacing) return
    for (const [runtime, adapter] of Object.entries(this.adapters)) {
      if (this.running.has(runtime) || this.bindingChanges.has(runtime) || !this.store.get('bindings', runtime)?.ready) continue
      if (this.store.all('tasks').some((t) => t.runtime === runtime && t.status === 'uncertain')) continue
      const task = this.store.all('tasks').find((t) => t.runtime === runtime && t.status === 'accepted')
      if (!task) continue
      this.running.add(runtime); this.update(task.id, { status: 'starting' })
      const execution = Promise.resolve().then(() => adapter.run(task, {
        started: (turn) => this.update(task.id, { status: 'running', native_turn_id: String(turn) }),
        interaction: (value) => this.interaction(task.id, value), resolved: (id) => this.resolveInteraction(task.id, id),
      })).then((result) => this.finish(task.id, result)).catch((e) => {
        this.update(task.id, { status: 'uncertain', reason: safeError(e) })
      }).finally(() => { this.running.delete(runtime); this.executions.delete(execution); this.schedule() })
      this.executions.add(execution)
    }
  }
  send(m) { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m)) }
  flush() { if (this.ready) for (const m of this.store.pending()) this.send(m) }
  status() {
    return { device_id: this.config.device_id, hub: this.config.hub, connected: this.ready === true, connected_at: this.connected_at || null, last_contact_at: this.last_contact_at || null, connection_error: this.connection_error || null, endpoints: this.endpoints(), pending_messages: this.store.pending().length, active_tasks: this.store.all('tasks').filter((t) => !TERMINAL.has(t.status)).map(({ id, runtime, status }) => ({ id, runtime, status })) }
  }
  checkCommunication() {
    if (!this.ready) return Promise.reject(fail('offline'))
    const nonce = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.checks.delete(nonce); reject(fail('communication-timeout')) }, 4000)
      this.checks.set(nonce, { resolve, reject, timer, started: Date.now() })
      this.send(frame('connection.check', { nonce }))
    })
  }
  async bindSession(runtime, sessionId) {
    if (this.unpairing || this.unpaired || this.revoked || this.replacing) throw fail('device-unpaired-or-replacing')
    const adapter = this.adapters[runtime]
    if (!adapter?.bindSession) throw fail('unknown-runtime')
    if (sessionId !== null && (typeof sessionId !== 'string' || !sessionId || sessionId.length > 256)) throw fail('invalid-session-id')
    const busy = () => this.running.has(runtime) || this.store.all('tasks').some((t) => t.runtime === runtime && !TERMINAL.has(t.status))
    if (this.bindingChanges.has(runtime) || busy()) throw fail('runtime-has-active-tasks')
    this.bindingChanges.add(runtime)
    try {
      while (this.refreshingRuntimes.has(runtime)) await sleep(10)
      if (this.stopped || busy()) throw fail('runtime-has-active-tasks')
      const before = this.store.get('bindings', runtime)
      this.markUnavailable(runtime); this.announce()
      const result = await adapter.bindSession(sessionId, this.config.cwd)
      if (!result?.session_id || (sessionId && result.session_id !== sessionId)) throw fail('session-mismatch')
      const changed = before?.session_id !== result.session_id
      const binding = { id: runtime, session_id: result.session_id, version: changed ? (before?.version || 0) + 1 : before.version, ready: true, context_reset: changed }
      this.store.put('bindings', binding); this.runtimeErrors.delete(runtime); this.announce(); return binding
    } catch (error) { this.runtimeErrors.set(runtime, safeError(error)); throw error }
    finally { this.bindingChanges.delete(runtime); this.schedule() }
  }
  async handleControl(req, res) {
    if (req.url !== '/control' || req.method !== 'POST') { res.writeHead(404); res.end(); return }
    if (!sameSecret(req.headers.authorization, 'Bearer ' + this.config.local_token)) { res.writeHead(401); res.end(); return }
    const chunks = []; let size = 0
    for await (const chunk of req) { size += chunk.length; if (size > MAX_FRAME) throw fail('body-too-large'); chunks.push(chunk) }
    const { method, payload = {} } = JSON.parse(Buffer.concat(chunks).toString())
    let value
    if (method === 'status') value = this.status()
    else if (method === 'communication.check') value = await this.checkCommunication()
    else if (method === 'session.bind') value = await this.bindSession(payload.runtime, payload.session_id)
    else if (method === 'unpair') value = await this.unpair()
    else if (method === 'pair.replace') {
      value = await this.preparePairReplace(payload)
      const operation = value
      res.once('finish', () => setImmediate(() => {
        void Promise.resolve().then(() => this.onPairReplace(payload)).then((result) => {
          writeConfig(join(this.home, 'pair-replace-state.json'), { ...operation, state: 'completed', result, completed_at: now() })
        }).catch((error) => {
          this.replacing = false
          writeConfig(join(this.home, 'pair-replace-state.json'), { ...operation, state: 'failed', error: safeError(error), ...(error.autostart_restore_error ? { autostart_restore_error: error.autostart_restore_error } : {}), completed_at: now() })
          if (!this.stopped) { void this.refresh(); this.schedule() }
        })
      }))
    }
    else throw fail('unknown-control-method')
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, value }))
  }
  async preparePairReplace(input) {
    if (!this.onPairReplace || !this.home) throw fail('running-worker-needs-upgrade-for-replace')
    if (input.replace !== true || !Array.isArray(input.runtimes) || !input.runtimes.length || input.runtimes.length !== 1 || input.runtimes[0] !== 'harness') throw fail('invalid-pair-replacement')
    if (this.replacing || this.unpairing || this.unpaired) throw fail('pair-replacement-in-progress')
    const busy = () => this.store.all('tasks').some((t) => !TERMINAL.has(t.status))
    if (busy()) throw fail('runtime-has-active-tasks')
    this.replacing = true
    try {
      for (const runtime of Object.keys(this.adapters)) this.markUnavailable(runtime)
      this.announce(true)
      // Ordered WSS round trip drains dispatches sent before the not-ready announcement.
      await this.checkCommunication()
      if (busy()) throw fail('runtime-has-active-tasks')
      const operation = { operation_id: randomUUID(), previous_device_id: this.config.device_id, state: 'accepted', accepted_at: now() }
      writeConfig(join(this.home, 'pair-replace-state.json'), operation)
      return operation
    } catch (error) { this.replacing = false; void this.refresh(); this.schedule(); throw error }
  }
  unpair() {
    if (this.unpairPromise) return this.unpairPromise
    if (this.replacing) return Promise.reject(fail('pair-replacement-in-progress'))
    if (!this.home) return Promise.reject(fail('worker-home-required'))
    this.unpairing = true
    this.unpairPromise = (async () => {
      while (this.refreshing || this.bindingChanges.size) await sleep(10)
      if (this.store.all('tasks').some((t) => !TERMINAL.has(t.status))) throw fail('runtime-has-active-tasks')
      const receipt = await requestUnpair(this.config)
      const result = finishUnpair(this.home, this.config, receipt)
      this.unpaired = true; this.ready = false
      setImmediate(() => this.onUnpaired?.())
      return result
    })().catch((error) => { this.unpairPromise = null; throw error }).finally(() => { this.unpairing = false; if (!this.unpaired) this.schedule() })
    return this.unpairPromise
  }
  close() { return this.closing ??= this.closeOnce() }
  async closeOnce() {
    this.stopped = true; clearInterval(this.timer); clearTimeout(this.reconnectTimer)
    this.ws?.terminate(); this.harnessSocket?.terminate()
    for (const check of this.checks.values()) { clearTimeout(check.timer); check.reject(fail('worker-stopped')) }; this.checks.clear()
    for (const adapter of Object.values(this.adapters)) await adapter.close?.()
    await Promise.allSettled([...this.executions])
    while (this.refreshing || this.controlsApplying.size || this.bindingChanges.size) await sleep(10)
    await this.unpairPromise?.catch(() => {})
    await new Promise((r) => this.local.close(r)); await new Promise((r) => this.server.close(r))
    this.store.close()
  }
}
