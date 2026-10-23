import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { PluginController } from '../src/controller.js'
import { installManagement } from '../src/management.js'
import { Hub } from '../src/hub.js'
import { removeAutostart, autostartPaths } from '../src/autostart.js'
import { postJson } from '../src/transport.js'
import { writeConfig } from '../src/util.js'
import { FakeHarnessContext, temp, until, autoReply } from './helpers.js'
import { ensureClientRegistration } from '../src/client-registration.js'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { workerOwner } from '../src/worker-runtime.js'
import { pairWorker } from '../src/pairing.js'

function context() {
  const ctx = new FakeHarnessContext(); ctx.tools = { register() {} }; ctx.routes = new Map()
  ctx.connection.fetch = { register: (route) => { ctx.routes.set(route.path, route); return () => ctx.routes.delete(route.path) } }
  const invoke = ctx.typertGateway.invoke
  ctx.typertGateway.invoke = (args) => args.method === 'list'
    ? Promise.resolve({ items: [...ctx.nativeSessions.keys()].map((id) => ({ sessionId: id, title: id, cwd: 'C:/work' })) }) : invoke(args)
  ctx.inject = (names, callback) => {
    const scope = Object.create(ctx); scope.disposers = []
    const pending = names.every((n) => ctx[n]) ? Promise.resolve().then(() => callback(scope)) : Promise.resolve()
    let closed
    return { then: (ok, bad) => pending.then(ok, bad), dispose: () => closed ??= pending.then(async () => { for (const d of scope.disposers.reverse()) await d() }) }
  }
  return ctx
}

test('UI binds the exact synced master, generates one-use codes, and never returns credentials', async (t) => {
  const dir = temp(t), before = process.env.DSH_HOME; process.env.DSH_HOME = dir
  const ctx = context(); ctx.makeSession('wechat-main')
  ctx.dshIm = { send: async () => { throw Error('No real delivery in UI tests') }, listBots: async () => [{ channel: 'weixin', botId: 'wx' }], listTargets: async () => [{ targetId: 'person', name: '微信用户', kind: 'user', sessionSync: { enabled: true } }] }
  writeConfig(join(dir, 'integrations/dsh-weixin/workspaces.json'), { deliveryTargets: { wx: { person: { sessionSync: { conversationKey: 'p2p:test' } } } } })
  writeConfig(join(dir, 'integrations/dsh-weixin/accounts/wx/state.json'), { sessions: { 'p2p:test': 'wechat-main' }, contextTokens: { secret: 'NEVER_RETURN' } })
  const controller = new PluginController(ctx, { role: 'hub', port: 0, dataDir: join(dir, 'hub') })
  t.after(async () => { await controller.close(); if (before === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = before })
  await controller.start(); await until(() => controller.master)
  assert.equal((await controller.call('targets.list')).targets[0].session_id, 'wechat-main')
  await assert.rejects(controller.call('master.bind', { session_id: 'wrong-session', bot_id: 'wx', target_id: 'person' }), /select-existing-weixin-synced-session/)
  await controller.call('master.bind', { session_id: 'wechat-main', bot_id: 'wx', target_id: 'person' })
  const pair = await controller.call('pair.create', { master_id: 'wechat-main' })
  const device = controller.master.hub.enroll({ code: pair.code, name: 'test worker' })
  assert.throws(() => controller.master.hub.enroll({ code: pair.code, name: 'duplicate' }), /invalid-pair-code/)
  const status = await controller.call('status')
  assert.equal(status.master.devices[0].online, false)
  assert.equal(JSON.stringify(status).includes('token'), false)
  assert.equal(JSON.stringify(status).includes('NEVER_RETURN'), false)
  assert.equal((await controller.call('sessions.list')).sessions[0].id, 'wechat-main')
  await controller.call('device.unpair', { device_id: device.device_id })
  assert.equal((await controller.call('status')).master.devices.length, 0)
  assert.ok(controller.master.hub.store.get('devices', device.device_id).revoked_at)
})

test('UI pairs and auto-starts a worker, checks authenticated round trips and changes exact Session binding', async (t) => {
  const dir = temp(t), home = join(dir, 'worker'), ctx = context(); autoReply(ctx, 'done')
  ctx.makeSession('existing-worker-session')
  const hub = await new Hub({ dbPath: join(dir, 'hub.sqlite'), adminToken: 'secret', port: 0 }).listen()
  hub.bindMaster({ session_id: 'main', bot_id: 'wx', target_id: 'person' })
  const controller = new PluginController(ctx, { role: 'harness', workerHome: home, dataDir: join(dir, 'plugin') })
  t.after(async () => { await controller.close(); await hub.close() })
  await controller.start()
  await controller.call('worker.pair', { hub: 'http://127.0.0.1:' + hub.server.address().port, code: hub.createPair('main').code, name: 'UI worker', cwd: dir, runtimes: ['harness'], local_port: 0 })
  await until(() => hub.listDevices('main')[0]?.endpoints[0]?.ready)
  assert.equal((await controller.call('worker.check')).connected, true)
  const original = hub.listDevices('main')[0].endpoints[0].session_id
  await assert.rejects(controller.call('worker.session.bind', { runtime: 'harness', session_id: 'does-not-exist' }))
  assert.equal(controller.worker.worker.endpoints()[0].session_id, original)
  await controller.call('worker.session.bind', { runtime: 'harness', session_id: 'existing-worker-session' })
  await until(() => hub.listDevices('main')[0].endpoints[0].session_id === 'existing-worker-session')
  assert.equal(controller.worker.worker.endpoints()[0].binding_version, 2)
  const state = await controller.call('status')
  assert.equal(state.worker.paired, true)
  assert.equal(JSON.stringify(state).includes('local_token'), false)
  const unauthorized = await fetch('http://127.0.0.1:' + controller.worker.worker.server.address().port + '/control', { method: 'POST', body: JSON.stringify({ method: 'status' }) })
  assert.equal(unauthorized.status, 401)
  const control = await postJson('http://127.0.0.1:' + controller.worker.worker.server.address().port + '/control', { method: 'status' }, { headers: { Authorization: 'Bearer ' + JSON.parse(readFileSync(join(home, 'config.json'))).local_token } })
  assert.equal(control.body.value.connected, true)
  const unpaired = await controller.call('worker.unpair')
  assert.ok(unpaired.receipt_id)
  assert.equal(existsSync(join(home, 'config.json')), false)
  assert.equal((await controller.call('status')).worker.paired, false)
  assert.equal(ctx.nativeSessions.has('existing-worker-session'), true)
  assert.equal(hub.listDevices('main').length, 0)
})

test('native management carrier validates envelopes and returns classified errors without raw diagnostics', async (t) => {
  const ctx = context()
  installManagement(ctx, { call: async (method) => { if (method === 'bad') throw Object.assign(Error('NEVER_RETURN credentials or transcript'), { code: 'offline' }); return { phase: 'running' } } })
  const route = ctx.routes.get('/api/agent-hub')
  const request = (method) => new Request('http://localhost/api/agent-hub', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'ui-1', method: 'agent-hub', payload: { method, payload: {} } }) })
  assert.deepEqual((await (await route.fetch(request('status'))).json()).result.value, { phase: 'running' })
  const failed = await (await route.fetch(request('bad'))).json()
  assert.equal(failed.result.error.code, 'offline')
  assert.equal(JSON.stringify(failed).includes('NEVER_RETURN'), false)
})


test('first UI upgrade invalidates only this package cached absence without touching other clients', () => {
  let flushed = false
  const meta = new Map([['profile\0dsh-agent-hub', null], ['profile\0unrelated-plugin', { keep: true }]])
  const registry = { clientPath: () => undefined, pkgMeta: meta, dirty: new Set(), flush: () => { flushed = true } }
  ensureClientRegistration({ inject: (_names, callback) => callback({ clientModules: registry }) })
  assert.equal(meta.has('profile\0dsh-agent-hub'), false)
  assert.equal(meta.has('profile\0unrelated-plugin'), true)
  assert.equal(flushed, true)
})

test('upgrading the installed directory refreshes only this client bundle cache', () => {
  const table = new Map([['dsh-agent-hub', { path: 'old-version' }], ['other-plugin', { keep: true }]])
  const registry = { clientPath: () => 'C:/old-version/src/client.js', pkgMeta: new Map([['profile\0dsh-agent-hub', {}]]), dirty: new Set(), table, flush() {} }
  ensureClientRegistration({ inject: (_names, callback) => callback({ clientModules: registry }) })
  assert.equal(table.has('dsh-agent-hub'), false)
  assert.equal(table.has('other-plugin'), true)
  assert.equal(registry.dirty.has('dsh-agent-hub'), true)
})

async function replacementFixture(t) {
  const dir = temp(t), home = join(dir, 'legacy-worker'), ctx = context()
  const hub = await new Hub({ dbPath: join(dir, 'hub.sqlite'), adminToken: 'test', port: 0 }).listen()
  hub.bindMaster({ session_id: 'main', bot_id: 'wx', target_id: 'test' })
  const address = 'http://127.0.0.1:' + hub.server.address().port
  const controller = new PluginController(ctx, { role: 'harness', workerHome: home, dataDir: join(dir, 'plugin') })
  t.after(async () => { await controller.close(); await hub.close() })
  await controller.start()
  await controller.call('worker.pair', { hub: address, code: hub.createPair('main').code, name: 'existing', cwd: dir, runtimes: ['harness'], local_port: 0 })
  await until(() => controller.worker?.worker?.endpoints()[0]?.ready && hub.listDevices('main')[0]?.online && hub.listDevices('main')[0]?.endpoints.some((e) => e.ready))
  const original = JSON.parse(readFileSync(join(home, 'config.json'))), session = controller.worker.worker.endpoints()[0].session_id
  const run = (code, runtimes = 'harness') => promisify(execFile)(process.execPath, ['bin/agent-hub.js', 'pair', '--home', home, '--hub', address, '--code', code, '--cwd', dir, '--name', 'replacement', '--runtimes', runtimes, '--replace', '--no-start'], { windowsHide: true })
  return { dir, home, ctx, hub, controller, original, session, run }
}

test('CLI --replace asks the owning plugin to close, pair and restart; failed pairing restores the fixed Session', async (t) => {
  const { home, hub, controller, original, session, run } = await replacementFixture(t)
  const before = process.env.APPDATA; process.env.APPDATA = join(home, 'isolated-appdata')
  t.after(() => { if (before === undefined) delete process.env.APPDATA; else process.env.APPDATA = before })
  writeConfig(join(home, 'autostart.json'), { node: process.execPath, root: process.cwd(), platform: process.platform })
  const startup = autostartPaths(home); mkdirSync(join(startup.entry, '..'), { recursive: true }); writeFileSync(startup.entry, 'legacy test entry; never executed')
  assert.equal(workerOwner(home).kind, 'plugin')
  await assert.rejects(run('invalid-expired-code'), (error) => error.stderr.includes('invalid-pair-code'))
  assert.equal(JSON.parse(readFileSync(join(home, 'config.json'))).device_id, original.device_id)
  await until(() => controller.worker?.worker?.endpoints()[0]?.ready)
  assert.equal(controller.worker.worker.endpoints()[0].session_id, session)
  assert.equal(existsSync(join(home, 'autostart.json')), false)
  assert.equal(existsSync(startup.entry), false)
  const code = hub.createPair('main').code
  await run(code)
  const replaced = JSON.parse(readFileSync(join(home, 'config.json')))
  assert.notEqual(replaced.device_id, original.device_id)
  await until(() => workerOwner(home)?.kind === 'plugin' && controller.worker?.worker?.endpoints()[0]?.ready)
  const audit = JSON.parse(readFileSync(join(home, 'pair-replace-state.json')))
  assert.equal(audit.state, 'completed')
  assert.equal(audit.result.device_id, replaced.device_id)
  assert.equal(JSON.stringify(audit).includes(code), false)
  assert.equal(workerOwner(home).pid, process.pid)
  assert.equal(existsSync(startup.entry), false)
})

test('CLI --replace refuses unfinished work and leaves the pairing code and binding intact', async (t) => {
  const { home, ctx, hub, controller, original, session, run } = await replacementFixture(t)
  ctx.agents.get(session).followup = (message) => setImmediate(() => {
    ctx.event(session, 'turn/start', { turn: 1 }); ctx.event(session, 'user/message', { turn: 1, source: message.source, content: message.content })
  })
  const task = hub.dispatch('main', { endpoint_id: original.device_id + ':harness', prompt: 'hold for a real completion' })
  await until(() => controller.worker.worker.status().active_tasks.length === 1)
  const code = hub.createPair('main').code
  await assert.rejects(run(code), (error) => error.stderr.includes('runtime-has-active-tasks'))
  assert.equal(JSON.parse(readFileSync(join(home, 'config.json'))).device_id, original.device_id)
  assert.equal(workerOwner(home).pid, process.pid)
  ctx.event(session, 'assistant/message', { turn: 1, step: 0, message: { content: [{ type: 'text', text: 'finished normally' }] } })
  ctx.event(session, 'turn/end', { turn: 1, reason: 'completed' })
  await until(() => hub.task('main', task.id).status === 'completed')
  await run(code)
})


test('stable install directory asks Harness to publish changed bytes without removing its client graph row', () => {
  let rebuilt = 0
  const registry = { clientPath: () => new URL('../src/client.js', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), rebuilt(id) { assert.equal(id, 'dsh-agent-hub'); rebuilt++ }, pkgMeta: new Map([['profile\0dsh-agent-hub', {}]]), dirty: new Set(), table: new Map([['dsh-agent-hub', {}]]), flush() { throw Error('Must retain graph row') } }
  const ctx = { inject: (_names, callback) => callback({ clientModules: registry }) }
  ensureClientRegistration(ctx); ensureClientRegistration(ctx)
  assert.equal(rebuilt, 2)
  assert.equal(registry.table.has('dsh-agent-hub'), true)
  assert.equal(registry.pkgMeta.has('profile\0dsh-agent-hub'), true)
})
