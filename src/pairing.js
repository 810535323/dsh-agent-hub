import { existsSync, readFileSync, mkdirSync, writeFileSync, realpathSync, statSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { X509Certificate } from 'node:crypto'
import { hostname } from 'node:os'
import { acquireWorker, workerOwner } from './worker-runtime.js'
import { Store } from './store.js'
import { TERMINAL } from './protocol.js'
import { requestUnpair, finishUnpair } from './unpair.js'
import { hubUrl, clientTLS, postJson } from './transport.js'
import { fail, secret, writeConfig, requireText, sleep } from './util.js'
import { distribution } from './installation.js'

export const packageRoot = resolve(import.meta.dirname, '..')
export function deploymentDefaults() {
  const path = join(packageRoot, 'deployment.json')
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {}
}
export async function pairWorker(home, input) {
  if (input.runtimes && (input.runtimes.length !== 1 || input.runtimes[0] !== 'harness')) throw fail('harness-only-use-local-subagent')
  input = { ...input, runtimes: ['harness'] }
  const owner = workerOwner(home)
  if (owner) {
    if (input.replace !== true) throw fail('worker-already-running-or-owner-unverifiable')
    if (owner.kind !== 'plugin') throw fail('external-worker-must-be-stopped-before-repair')
    let operation
    try { operation = await workerControl(home, 'pair.replace', input) }
    catch (e) { if (e.code === 'unknown-control-method') throw fail('running-worker-needs-upgrade-for-replace'); throw e }
    const deadline = Date.now() + 30000
    while (Date.now() < deadline) {
      const path = join(home, 'pair-replace-state.json')
      const status = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null
      if (status?.operation_id === operation.operation_id) {
        if (status.state === 'completed') return status.result
        if (status.state === 'failed') throw fail(status.error || 'pair-replacement-failed')
      }
      await sleep(100)
    }
    throw fail('pair-replacement-pending-check-status')
  }
  const release = acquireWorker(home, 'pair')
  try { return await pairStoppedWorker(home, input) } finally { release() }
}
async function pairStoppedWorker(home, input) {
  const path = join(home, 'config.json')
  if (existsSync(path) && input.replace !== true) throw fail('already-paired-use-replace-explicitly')
  const hub = hubUrl(input.hub, input.allow_insecure === true)
  requireText(input.code, 'pair-code', 128)
  const cwd = realpathSync(resolve(input.cwd))
  if (!statSync(cwd).isDirectory()) throw fail('workspace-directory-required')
  const runtimes = ['harness']
  if (!Array.isArray(runtimes) || !runtimes.length || new Set(runtimes).size !== runtimes.length || runtimes.some((r) => !['codex', 'harness'].includes(r))) throw fail('invalid-runtimes')
  if (runtimes.some((r) => !distribution().runtimes.includes(r))) throw fail('runtime-not-supported-by-this-package')
  const port = input.local_port ?? 0
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw fail('invalid-local-port')
  const defaults = deploymentDefaults()
  const ca = input.ca_pem ? Buffer.from(requireText(input.ca_pem, 'certificate', 32000))
    : input.ca_file ? clientTLS(input).ca
      : defaults.hub === hub && defaults.caFile ? readFileSync(join(packageRoot, defaults.caFile)) : null
  if (ca) { try { new X509Certificate(ca) } catch { throw fail('invalid-certificate') } }
  const response = await postJson(hub + '/v2/enroll', { code: input.code.trim(), name: input.name || hostname() }, ca ? { ca } : {})
  if (response.status !== 200 || !response.body.ok) throw fail(response.body.error || 'pair-failed')
  const { device_id, token } = response.body
  requireText(device_id, 'device-id', 256); requireText(token, 'device-token', 256)
  if (!/^dev_[a-zA-Z0-9-]+$/.test(device_id)) throw fail('invalid-device-id')
  const config = { hub, device_id, token, name: input.name || hostname(), local_token: secret(), cwd, runtimes, database: 'worker-' + device_id + '.sqlite', local_port: port }
  if (input.allow_insecure === true) config.allow_insecure = true
  mkdirSync(home, { recursive: true, mode: 0o700 })
  if (ca) { config.ca_file = join(home, 'hub-ca-' + device_id + '.pem'); writeFileSync(config.ca_file, ca, { mode: 0o600 }) }
  writeConfig(path, config)
  return { device_id, hub, name: config.name, cwd, runtimes }
}
export async function workerControl(home, method, payload = {}) {
  const config = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'))
  const owner = workerOwner(home)
  if (owner?.device_id && owner.device_id !== config.device_id) throw fail('worker-owner-unverifiable')
  const port = owner?.control_port || config.local_port
  if (!port) throw fail('worker-not-running-or-starting')
  const result = await postJson('http://127.0.0.1:' + port + '/control', { method, payload }, { headers: { Authorization: 'Bearer ' + config.local_token } })
  if (!result.body.ok) throw fail(result.body.error || 'worker-control-failed')
  return result.body.value
}

export async function unpairWorker(home) {
  if (!existsSync(join(home, 'config.json'))) return { unpaired: true, already_unpaired: true }
  if (workerOwner(home)) return workerControl(home, 'unpair')
  const release = acquireWorker(home, 'unpair')
  try {
    const config = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'))
    const store = new Store(join(home, config.database || 'worker.sqlite'))
    try { if (store.all('tasks').some((t) => !TERMINAL.has(t.status))) throw fail('runtime-has-active-tasks') }
    finally { store.close() }
    return finishUnpair(home, config, await requestUnpair(config))
  } finally { release() }
}
