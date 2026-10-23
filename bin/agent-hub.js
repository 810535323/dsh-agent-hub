#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { Store } from '../src/store.js'
import { fail, safeError } from '../src/util.js'
import { workerOwner } from '../src/worker-runtime.js'
import { pairWorker, unpairWorker, workerControl } from '../src/pairing.js'
import { removeAutostart } from '../src/autostart.js'
import { workerHome, distribution } from '../src/installation.js'

const [command, ...rest] = process.argv.slice(2)
const args = {}
for (let i = 0; i < rest.length; i++) {
  if (!rest[i].startsWith('--')) throw fail('invalid-option')
  const key = rest[i].slice(2); args[key] = rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : true
}
const home = resolve(args.home || workerHome('harness'))
const configPath = join(home, 'config.json')
const load = () => JSON.parse(readFileSync(configPath, 'utf8'))
async function runWorker() { throw fail('start-harness-plugin-instead-of-standalone-worker') }
async function main() {
  if ((args.runtime && args.runtime !== 'harness') || (args.runtimes && args.runtimes !== 'harness') || args.codex) throw fail('harness-only-use-local-subagent')
  if (command === 'paths') { const owner = workerOwner(home); console.log(JSON.stringify({ distribution: distribution().kind, runtime: 'harness', home, worker_owner: owner ? { kind: owner.kind, pid: owner.pid } : null })); return }
  if (command === 'doctor') {
    const installed = existsSync(configPath) ? load() : {}
    console.log(JSON.stringify({ channel: 'latest', node: process.version, sqlite: true, paired: !!installed.device_id, distribution: distribution().kind, runtime_support: ['harness'], autostart: 'with-harness', data_directory: home }, null, 2))
    return
  }
  if (command === 'pair') {
    await pairWorker(home, { hub: args.hub, code: args.code, name: args.name, cwd: args.cwd || process.cwd(), runtimes: String(args.runtimes || 'harness').split(','), local_port: Number(args['local-port'] ?? 0), ca_file: args['ca-file'] ? resolve(args['ca-file']) : undefined, allow_insecure: args['allow-insecure'] === true, replace: args.replace === true })
    console.log('绑定已保存，Harness 插件随软件启动并创建或恢复固定 Session。'); return
  }
  if (command === 'start') { await runWorker(); return }
  if (command === 'unpair') { console.log(JSON.stringify(await unpairWorker(home), null, 2)); return }
  if (command === 'check') { console.log(JSON.stringify(await workerControl(home, 'communication.check'), null, 2)); return }
  if (command === 'session-bind') { console.log(JSON.stringify(await workerControl(home, 'session.bind', { runtime: 'harness', session_id: args.new === true ? null : args['session-id'] }), null, 2)); return }
  if (command === 'autostart') {
    if (!args.remove) throw fail('start-harness-plugin-instead-of-standalone-worker')
    const value = removeAutostart(home)
    console.log(JSON.stringify(value, null, 2)); return
  }
  if (command === 'status') {
    const config = load()
    const store = new Store(join(home, config.database || 'worker.sqlite'))
    try { console.log(JSON.stringify({ bindings: store.all('bindings'), tasks: store.all('tasks').map(({ prompt, ...t }) => t), receipts: Number(store.db.prepare('SELECT COUNT(*) AS n FROM receipts').get().n), pair_replace: existsSync(join(home, 'pair-replace-state.json')) ? JSON.parse(readFileSync(join(home, 'pair-replace-state.json'), 'utf8')) : null }, null, 2)) } finally { store.close() }
    return
  }
  if (command === 'migrate-legacy') {
    const source = JSON.parse(readFileSync(resolve(args.source), 'utf8'))
    if (!source.devices || !Array.isArray(source.events)) throw fail('invalid-legacy-database')
    const store = new Store(join(resolve(args['data-dir'] || '.work/standalone-hub'), 'hub.sqlite'))
    try {
      store.transaction(() => {
        for (const d of Object.values(source.devices)) store.put('legacy_devices', { id: d.device_id, name: d.name, kind: d.kind, requires_pairing: true })
        for (const [i, e] of source.events.entries()) store.put('legacy_events', { ...e, id: String(e.device_id) + ':' + String(e.event_id || i) })
      })
      console.log(JSON.stringify({ archived_devices: store.all('legacy_devices').length, archived_events: store.all('legacy_events').length, credentials_imported: false }))
    } finally { store.close() }
    return
  }

  console.log('Agent Hub 最新版本（仅 Harness）\nagent-hub doctor\nagent-hub pair --hub https://IP:9443 --code CODE --cwd PROJECT [--replace]\nagent-hub check\nagent-hub session-bind --session-id SESSION_ID\nagent-hub status\nagent-hub unpair\n启动和退出由 Harness 插件管理。')
}
main().catch((error) => { console.error(safeError(error)); process.exitCode = 1 })
