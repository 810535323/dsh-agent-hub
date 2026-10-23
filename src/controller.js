import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir, hostname } from 'node:os'
import { startHub } from './hub-runtime.js'
import { startHarnessWorker } from './harness-plugin.js'
import { pairWorker, unpairWorker, workerControl, deploymentDefaults } from './pairing.js'
import { writeConfig, fail, safeError, requireText } from './util.js'
import { TERMINAL } from './protocol.js'
import { hubUrl } from './transport.js'
import { releaseIndex } from './releases.js'
import { workerHome, dataHome } from './installation.js'
import { autostartRegistration, removeAutostart } from './autostart.js'

export class PluginController {
  constructor(ctx, config = {}) {
    this.ctx = ctx; this.baseConfig = config
    this.home = config.dataDir || dataHome()
    this.settingsPath = join(this.home, 'plugin-settings.json')
    const saved = existsSync(this.settingsPath) ? JSON.parse(readFileSync(this.settingsPath, 'utf8')) : {}
    this.settings = { role: config.role || 'setup', host: config.host || '127.0.0.1', port: config.port ?? 9444, tls: config.tls, workerHome: config.workerHome || workerHome('harness'), publicUrl: deploymentDefaults().hub || '', ...saved }
    this.phase = 'starting'; this.queue = Promise.resolve(); this.startedAt = new Date().toISOString()
    this.peer = ctx.connection.createPeer({ principal: { kind: 'owner' }, interactions: 'none' })
  }
  run(fn) {
    const result = this.queue.then(() => { if (this.closed) throw fail('plugin-stopped'); return fn() })
    this.queue = result.catch(() => {}); return result
  }
  start() { return this.run(() => this.activate()).catch((e) => { this.error = safeError(e); this.phase = 'error' }) }
  createWorker() { return startHarnessWorker(this.ctx, { workerHome: this.settings.workerHome, autoStart: true, onPairReplace: (input) => this.replaceWorker(input) }) }
  replaceWorker(input) {
    return this.run(async () => {
      if (this.settings.role !== 'harness') throw fail('worker-role-required')
      if (input.runtimes && (input.runtimes.length !== 1 || input.runtimes[0] !== 'harness')) throw fail('harness-only-use-local-subagent')
      input = { ...input, runtimes: ['harness'] }
      if (this.busy()) throw fail('runtime-has-active-tasks')
      const previousHome = this.settings.workerHome
      const registration = this.worker?.status().managed ? autostartRegistration(previousHome) : null
      if (registration) {
        requireText(registration.node, 'autostart-node', 2048); requireText(registration.root, 'autostart-root', 2048)
        removeAutostart(previousHome)
      }
      await this.worker?.close(); this.worker = null
      try {
        return await pairWorker(previousHome, { local_port: this.baseConfig.workerLocalPort ?? 0, ...input })
      } finally { if (!this.closed) this.worker = this.createWorker() }
    })
  }
  async activate() {
    this.error = null; this.phase = this.settings.role === 'setup' ? 'setup' : 'starting'
    if (this.settings.role === 'hub') {
      this.phase = 'waiting_im'
      this.fiber = this.ctx.inject(['dshIm'], async (scope) => {
        try {
          const master = await startHub(scope, { ...this.baseConfig, ...this.settings, dataDir: this.home })
          if (this.closed) return
          this.master = master; this.im = scope.dshIm; this.phase = 'running'
          scope.effect(() => () => { if (this.master === master) { this.master = null; this.im = null; if (!this.closed) this.phase = 'waiting_im' } })
        } catch (error) { this.error = safeError(error); this.phase = 'error' }
      })
    } else if (this.settings.role === 'harness') {
      this.worker = this.createWorker()
      this.phase = 'running'
    }
  }
  async stopRuntime() {
    await this.worker?.close(); this.worker = null
    await this.fiber?.dispose?.(); this.fiber = null; this.master = null; this.im = null
  }
  busy() {
    return !!this.master?.hub.store.all('tasks').some((t) => !TERMINAL.has(t.status)) || !!this.worker?.worker?.status().active_tasks.length
  }
  async configure(input) {
    return this.run(async () => {
      if (this.busy()) throw fail('runtime-has-active-tasks')
      if (!['hub', 'harness'].includes(input.role)) throw fail('invalid-role')
      const next = { ...this.settings, role: input.role }
      if (input.publicUrl !== undefined) next.publicUrl = hubUrl(input.publicUrl)
      if (input.host !== undefined) next.host = requireText(input.host, 'host', 100)
      if (input.port !== undefined) { if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) throw fail('invalid-port'); next.port = input.port }
      if (input.workerHome !== undefined) next.workerHome = resolve(requireText(input.workerHome, 'worker-home', 2048))
      // TLS files remain local settings; the page never accepts or returns a private key's contents.
      if (input.certFile || input.keyFile) {
        if (!input.certFile || !input.keyFile) throw fail('tls-cert-and-key-required')
        next.tls = { certFile: resolve(input.certFile), keyFile: resolve(input.keyFile) }
      }
      writeConfig(this.settingsPath, next)
      await this.stopRuntime(); this.settings = next; await this.activate()
      return { saved: true }
    })
  }
  async sessions() {
    const result = await this.ctx.typertGateway.invoke({ namespace: 'session', method: 'list', args: { _request: {} }, peer: this.peer })
    const rows = result.sessions || result.items || []
    return rows.slice(0, 500).map((row) => ({ id: row.id || row.sessionId || row.header?.id, title: row.title || row.projections?.values?.title || row.header?.title || row.id || row.sessionId, cwd: row.cwd || row.header?.cwd || '' })).filter((row) => row.id)
  }
  targetSession(botId, targetId) {
    if (!/^[a-zA-Z0-9_-]+$/.test(botId)) return null
    try {
      // DSH-IM's public target facade omits Session IDs. Read only its local binding
      // metadata to verify the chosen master, without reading credentials or messages.
      const root = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'integrations', 'dsh-weixin')
      const workspaces = JSON.parse(readFileSync(join(root, 'workspaces.json'), 'utf8'))
      const key = workspaces.deliveryTargets?.[botId]?.[targetId]?.sessionSync?.conversationKey
      if (!key) return null
      return JSON.parse(readFileSync(join(root, 'accounts', botId, 'state.json'), 'utf8')).sessions?.[key] || null
    } catch { return null }
  }
  async targets() {
    if (!this.im) return []
    const result = []
    for (const bot of (await this.im.listBots()).filter((b) => b.channel === 'weixin')) {
      for (const target of (await this.im.listTargets(bot.botId)).filter((t) => t.kind === 'user')) {
        result.push({ bot_id: bot.botId, target_id: target.targetId, name: target.name || target.targetId, sync_enabled: target.sessionSync?.enabled === true, session_id: this.targetSession(bot.botId, target.targetId) })
      }
    }
    return result
  }
  async bindMaster(input) {
    if (!this.master) throw fail('master-not-running')
    const targets = await this.targets()
    const target = targets.find((t) => t.bot_id === input.bot_id && t.target_id === input.target_id && t.sync_enabled)
    if (!target || target.session_id !== input.session_id) throw fail('select-existing-weixin-synced-session')
    const inspected = await this.ctx.sessionController.inspect(input.session_id)
    if (inspected.meta.id !== input.session_id) throw fail('session-mismatch')
    return this.master.hub.bindMaster(input)
  }
  async status() {
    const settings = { role: this.settings.role, host: this.settings.host, port: this.settings.port, publicUrl: this.settings.publicUrl, workerHome: this.settings.workerHome, tls: !!this.settings.tls }
    const base = { version: 'latest', phase: this.phase, error: this.error, settings, started_at: this.startedAt, autostart: 'harness', hostname: hostname(), defaults: { hub: deploymentDefaults().hub || '', name: hostname() } }
    if (this.master) {
      const { hub } = this.master
      base.master = { masters: hub.store.all('masters'), devices: hub.listDevices(), active_tasks: hub.store.all('tasks').filter((t) => !TERMINAL.has(t.status)).length }
      base.master.reports = this.master.coordinator.reportStatus()
      base.master.pairs = hub.store.all('pair_history').map(({ public_id, master_id, created_at, expires_at, used_at }) => ({ pair_id: public_id, master_id, created_at, expires_at, status: used_at ? 'used' : expires_at < Date.now() ? 'expired' : 'unused' })).slice(-20)
      base.releases = releaseIndex(this.baseConfig.releaseDir || join(this.home, 'releases'))
    }
    if (this.settings.role === 'harness') {
      const path = join(this.settings.workerHome, 'config.json')
      const cfg = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null
      base.worker = { ...this.worker?.status(), paired: !!cfg, config: cfg ? { device_id: cfg.device_id, name: cfg.name, hub: cfg.hub, cwd: cfg.cwd, runtimes: ['harness'] } : null }
      if (this.worker?.worker) base.worker.communication = this.worker.worker.status()
      else if (cfg) { try { base.worker.communication = await workerControl(this.settings.workerHome, 'status') } catch (e) { base.worker.control_error = safeError(e) } }
    }
    return base
  }
  async call(method, input = {}) {
    if (method === 'status') return this.status()
    if (method === 'sessions.list') return { sessions: await this.sessions() }
    if (method === 'settings.save') return this.configure(input)
    if (method === 'targets.list') return { targets: await this.targets() }
    if (method === 'master.bind') return this.run(() => this.bindMaster(input))
    if (method === 'device.unpair') return this.run(() => {
      if (!this.master) throw fail('master-not-running')
      const device = this.master.hub.store.get('devices', requireText(input.device_id, 'device-id', 256))
      if (!device) throw fail('unknown-device')
      return this.master.hub.unpairDevice(device.master_id, device.id)
    })
    if (method === 'worker.unpair') return this.run(async () => {
      if (this.settings.role !== 'harness') throw fail('worker-role-required')
      const value = this.worker?.worker ? await this.worker.worker.unpair() : await unpairWorker(this.settings.workerHome)
      await this.worker?.close()
      this.worker = this.createWorker()
      return value
    })
    if (method === 'pair.create') {
      if (!this.master) throw fail('master-not-running')
      return { ...this.master.hub.createPair(input.master_id), hub: this.settings.publicUrl }
    }
    if (method === 'worker.pair') return this.replaceWorker(input)
    if (method === 'worker.check' || method === 'worker.session.bind') {
      if (this.settings.role !== 'harness') throw fail('worker-role-required')
      const worker = this.worker?.worker
      if (input.runtime && input.runtime !== 'harness') throw fail('harness-only-use-local-subagent')
      input = { ...input, runtime: 'harness' }
      if (worker) return method === 'worker.check' ? worker.checkCommunication() : worker.bindSession('harness', input.session_id)
      return workerControl(this.settings.workerHome, method === 'worker.check' ? 'communication.check' : 'session.bind', input)
    }
    throw fail('unknown-management-method')
  }
  async close() {
    this.closed = true; await this.queue; await this.stopRuntime(); this.peer?.dispose?.()
  }
}
