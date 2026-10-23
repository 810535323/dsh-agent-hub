import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { Hub } from '../src/hub.js'
import { startHarnessWorker } from '../src/harness-plugin.js'
import { startWorkerRuntime } from '../src/worker-runtime.js'
import { writeConfig } from '../src/util.js'
import { temp, until, FakeHarnessContext, autoReply } from './helpers.js'

async function setup(t, options = {}) {
  const dir = temp(t)
  const hub = await new Hub({ dbPath: join(dir, 'hub.sqlite'), adminToken: 'test', port: 0 }).listen()
  hub.bindMaster({ session_id: 'main', bot_id: 'wx', target_id: 'person' })
  const device = hub.enroll({ code: hub.createPair('main').code, name: 'automatic' })
  const ctx = new FakeHarnessContext(); autoReply(ctx, '自动执行结果')
  const config = { hub: 'http://127.0.0.1:' + hub.server.address().port, ...device, local_token: 'local-secret', cwd: dir, local_port: 0, runtimes: ['harness'], ...options }
  writeConfig(join(dir, 'config.json'), config)
  return { dir, hub, ctx, config, endpoint: device.device_id + ':harness' }
}

test('plugin starts Worker, executes tasks, releases ownership on unload and reuses its Session on reload', async (t) => {
  const { dir, hub, ctx, config, endpoint } = await setup(t)
  let plugin = startHarnessWorker(ctx, { workerHome: dir })
  t.after(async () => { await plugin.close(); await hub.close() })
  await until(() => hub.listDevices('main')[0]?.endpoints[0]?.ready)
  const session = hub.listDevices('main')[0].endpoints[0].session_id
  assert.equal(plugin.status().state, 'managed')
  assert.equal(JSON.parse(readFileSync(join(dir, 'worker.pid.json'))).kind, 'plugin')
  await assert.rejects(startWorkerRuntime({ home: dir }), /worker-already-running/)
  const first = hub.dispatch('main', { endpoint_id: endpoint, prompt: 'first' })
  await until(() => hub.task('main', first.id).status === 'completed')
  assert.equal(hub.task('main', first.id).result.answer, '自动执行结果')
  await plugin.close()
  assert.equal(existsSync(join(dir, 'worker.pid.json')), false)
  await until(() => !hub.isOnline(config.device_id))
  plugin = startHarnessWorker(ctx, { workerHome: dir })
  await until(() => hub.listDevices('main')[0]?.endpoints[0]?.ready)
  assert.equal(hub.listDevices('main')[0].endpoints[0].session_id, session)
  const second = hub.dispatch('main', { endpoint_id: endpoint, prompt: 'second' })
  await until(() => hub.task('main', second.id).status === 'completed')
})

test('plugin connects to an existing CLI Worker without starting or stopping a second Worker', async (t) => {
  const { dir, hub, ctx, config } = await setup(t)
  const external = await startWorkerRuntime({ home: dir })
  writeConfig(join(dir, 'config.json'), { ...config, local_port: external.worker.server.address().port })
  const plugin = startHarnessWorker(ctx, { workerHome: dir })
  t.after(async () => { await plugin.close(); await external.close(); await hub.close() })
  await until(() => hub.listDevices('main')[0]?.endpoints[0]?.ready)
  assert.equal(plugin.status().state, 'external')
  assert.equal(plugin.status().managed, false)
  await plugin.close()
  assert.equal(external.worker.server.listening, true)
  assert.equal(hub.isOnline(config.device_id), true)
})

test('unpaired plugin notices CLI pair --no-start and starts without a console Worker', async (t) => {
  const dir = temp(t)
  const hub = await new Hub({ dbPath: join(dir, 'hub.sqlite'), adminToken: 'test', port: 0 }).listen()
  hub.bindMaster({ session_id: 'main', bot_id: 'wx', target_id: 'person' })
  const home = join(dir, 'worker'); const ctx = new FakeHarnessContext()
  const plugin = startHarnessWorker(ctx, { workerHome: home })
  t.after(async () => { await plugin.close(); await hub.close() })
  assert.equal(plugin.status().state, 'waiting_binding')
  const child = spawn(process.execPath, [fileURLToPath(new URL('../bin/agent-hub.js', import.meta.url)), 'pair', '--home', home, '--hub', 'http://127.0.0.1:' + hub.server.address().port, '--code', hub.createPair('main').code, '--runtimes', 'harness', '--cwd', dir, '--local-port', '0', '--no-start'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.resume(); child.stderr.resume()
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill() })
  const [code] = await once(child, 'close')
  assert.equal(code, 0)
  await until(() => hub.listDevices('main')[0]?.endpoints[0]?.ready)
  assert.equal(plugin.status().managed, true)
})

test('unverifiable Worker ownership blocks automatic execution', async (t) => {
  const { dir, hub, ctx } = await setup(t)
  writeFileSync(join(dir, 'worker.pid.json'), '{incomplete')
  const plugin = startHarnessWorker(ctx, { workerHome: dir })
  t.after(async () => { await plugin.close(); await hub.close() })
  await until(() => plugin.status().state === 'error:worker-owner-unverifiable')
  assert.equal(plugin.status().managed, false)
  assert.equal(hub.listDevices('main')[0].online, false)
})
