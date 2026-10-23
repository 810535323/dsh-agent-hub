import { resolve } from 'node:path'
import { WebSocket } from 'ws'
import { Rpc } from './rpc.js'
import { HarnessHost } from './harness-host.js'
import { readWorkerConfig, startWorkerRuntime, workerOwner } from './worker-runtime.js'
import { safeError } from './util.js'
import { workerHome } from './installation.js'

export const name = 'agent-hub-harness-worker'
export const inject = ['agents', 'sessions', 'sessionController', 'typertGateway', 'connection', 'sessionPersistence']
export function apply(ctx, config = {}) { startHarnessWorker(ctx, config) }

export function startHarnessWorker(ctx, config = {}) {
  const home = resolve(config.workerHome || workerHome('harness'))
  const native = new HarnessHost(ctx)
  const logger = typeof ctx.logger === 'function' ? ctx.logger('agent-hub-worker') : ctx.logger
  let stopped = false, socket, runtime, startingWorker, pending, closing, state = 'waiting_binding', lastLog
  const report = (value) => {
    state = value
    if (lastLog !== value) { lastLog = value; logger?.info?.('Worker: ' + value) }
  }
  const connect = (cfg) => {
    if (stopped || !cfg.runtimes.includes('harness') || socket) return
    const port = runtime?.worker.server.address()?.port ?? workerOwner(home)?.control_port ?? cfg.local_port
    if (!port) return
    const ws = socket = new WebSocket(`ws://127.0.0.1:${port}/harness`, { headers: { Authorization: 'Bearer ' + cfg.local_token }, maxPayload: 256 * 1024 })
    const rpc = new Rpc((m) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m)) })
    rpc.on('request', async (m) => {
      try {
        let result; const p = m.params
        if (m.method === 'session.ensure') result = await native.ensure(p, p.cwd)
        else if (m.method === 'session.validate') { const session = await native.inspect(p.session_id); result = { session_id: session.meta.id } }
        else if (m.method === 'task.run') result = await native.run(p, {
          started: (id) => rpc.notify('runtime.started', { task_id: p.id, native_turn_id: id }),
          interaction: (interaction) => rpc.notify('runtime.interaction', { task_id: p.id, interaction }),
          resolved: (id) => rpc.notify('runtime.interaction-resolved', { task_id: p.id, interaction_id: id }),
        })
        else if (m.method === 'task.reconcile') result = await native.reconcile(p)
        else if (m.method === 'task.cancel') result = await native.cancel({ id: p.task_id, ...p })
        else if (m.method === 'task.decision') result = await native.decision({ id: p.task_id }, { native_id: p.interaction_id }, p.answer)
        else throw Object.assign(new Error(), { code: 'unknown-method' })
        if (ws.readyState === WebSocket.OPEN) rpc.respond(m.id, result ?? null)
      } catch (error) { if (ws.readyState === WebSocket.OPEN) rpc.respond(m.id, null, error) }
    })
    ws.on('message', (raw) => { try { rpc.receive(JSON.parse(String(raw))) } catch { ws.close() } })
    ws.on('error', () => {})
    ws.once('close', () => { rpc.close(); if (socket === ws) socket = null })
  }
  const tick = () => {
    if (stopped || pending) return pending
    pending = (async () => {
      try {
        if (runtime?.worker.unpaired) { await runtime.close(); runtime = null; socket?.terminate(); socket = null }
        const cfg = runtime?.config || readWorkerConfig(home)
        if (!cfg.runtimes.includes('harness')) throw Object.assign(new Error(), { code: 'worker-profile-does-not-provide-harness' })
        if (config.autoStart !== false && !runtime) {
          if (workerOwner(home)) report('external')
          else {
            report('starting')
            try {
              runtime = await startWorkerRuntime({ home, kind: 'plugin', onCreate: (worker) => { startingWorker = worker; worker.onPairReplace = config.onPairReplace } })
            } catch (error) {
              if (error.code !== 'worker-already-running-or-owner-unverifiable') throw error
              report('external')
            } finally { startingWorker = null }
          }
        }
        if (stopped) return
        if (runtime) report('managed')
        else if (config.autoStart === false) report('external')
        connect(cfg)
      } catch (error) { if (!stopped) report(error.code === 'ENOENT' ? 'waiting_binding' : 'error:' + safeError(error)) }
    })().finally(() => { pending = null })
    return pending
  }
  const timer = setInterval(tick, 1500); timer.unref()
  const close = () => closing ??= (async () => {
    stopped = true; clearInterval(timer)
    native.close(); socket?.terminate()
    if (startingWorker) {
      startingWorker.stopped = true
      await Promise.allSettled(Object.values(startingWorker.adapters).map((adapter) => adapter.close?.()))
    }
    await pending
    await runtime?.close()
    report('stopped')
  })()
  ctx.effect(() => close)
  void tick()
  return { close, status: () => ({ state, managed: !!runtime && !runtime.worker.unpaired, connected: socket?.readyState === WebSocket.OPEN, home }), get worker() { return runtime?.worker.unpaired ? undefined : runtime?.worker } }
}
