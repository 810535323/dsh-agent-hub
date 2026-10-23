// Invoked only by the optional isolated real-Host smoke runner, never by normal unit tests.
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { HarnessHost } from '../../src/harness-host.js'
import { startHub } from '../../src/plugin.js'
import { startHarnessWorker } from '../../src/harness-plugin.js'
import { writeConfig } from '../../src/util.js'
export const name = 'agent-hub-native-smoke'
export const inject = ['agents', 'sessions', 'tools', 'sessionController', 'typertGateway', 'connection', 'approval', 'sessionPersistence']
export async function apply(ctx) {
  try {
    const native = new HarnessHost(ctx)
    const path = join(process.env.DSH_HOME, 'smoke-binding.json')
    const previous = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null
    const binding = await native.ensure(previous, process.env.DSH_HOME)
    if (previous && binding.session_id !== previous.session_id) throw new Error('Native Session changed identity across restart')
    await native.agent(binding.session_id)
    writeConfig(path, binding)
    ctx.provide('dshIm', { send: async () => { throw new Error('Real WeChat delivery is forbidden in smoke tests') } })
    const { hub, coordinator } = await startHub(ctx, { dataDir: join(process.env.DSH_HOME, 'hub'), port: 0 })
    hub.bindMaster({ session_id: binding.session_id, bot_id: 'smoke-only', target_id: 'never-send' })
    const device = hub.listDevices(binding.session_id)[0] || hub.enroll({ code: hub.createPair(binding.session_id).code, name: 'native managed worker' })
    const workerHome = join(process.env.DSH_HOME, 'managed-worker')
    const configPath = join(workerHome, 'config.json')
    const saved = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : null
    const deviceId = device.device_id || device.id
    const token = device.token || (saved?.device_id === deviceId ? saved.token : null)
    if (!token) throw new Error('Native smoke device lost its saved token')
    writeConfig(configPath, { hub: 'http://127.0.0.1:' + hub.server.address().port, device_id: deviceId, token, local_token: 'smoke-local-only', runtimes: ['harness'], local_port: 0, cwd: process.env.DSH_HOME })
    const managed = startHarnessWorker(ctx, { workerHome })
    const deadline = Date.now() + 10000
    while (!hub.listDevices(binding.session_id)[0]?.endpoints[0]?.ready) {
      if (Date.now() > deadline) throw new Error('Managed native Worker did not become ready: ' + managed.status().state)
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    const workerBinding = hub.listDevices(binding.session_id)[0].endpoints[0].session_id
    const workerBindingPath = join(process.env.DSH_HOME, 'smoke-worker-binding.json')
    if (existsSync(workerBindingPath) && JSON.parse(readFileSync(workerBindingPath, 'utf8')).session_id !== workerBinding) throw new Error('Managed Worker replaced its fixed native Session')
    writeConfig(workerBindingPath, { session_id: workerBinding })
    await managed.close()
    coordinator.close(); await hub.close(); native.close()
    process.stdout.write('AGENT_HUB_NATIVE_HOST_OK ' + (previous ? 'cold-resume' : 'create') + '\n')
    process.exit(0)
  } catch (e) {
    process.stderr.write('AGENT_HUB_NATIVE_HOST_FAILED ' + String(e.stack) + '\n'); process.exit(1)
  }
}
