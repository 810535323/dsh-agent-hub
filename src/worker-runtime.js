import { existsSync, readFileSync, mkdirSync, openSync, closeSync, writeFileSync, unlinkSync, realpathSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { Worker } from './worker.js'
import { HarnessBridge } from './adapters/harness-bridge.js'
import { hubUrl } from './transport.js'
import { fail, requireText, writeConfig } from './util.js'
import { TERMINAL } from './protocol.js'
import { autostartRegistration, removeAutostart } from './autostart.js'

function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw fail('worker-owner-unverifiable')
  try { process.kill(pid, 0); return true }
  catch (error) { if (error.code === 'ESRCH') return false; throw fail('worker-owner-unverifiable') }
}
export function workerOwner(home) {
  const path = join(home, 'worker.pid.json')
  if (!existsSync(path)) return null
  let owner
  try { owner = JSON.parse(readFileSync(path, 'utf8')) } catch { throw fail('worker-owner-unverifiable') }
  return alive(owner.pid) ? owner : null
}
export function assertWorkerStopped(home) {
  if (workerOwner(home)) throw fail('worker-already-running-or-owner-unverifiable')
}
export function readWorkerConfig(home) {
  const config = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'))
  config.hub = hubUrl(config.hub, config.allow_insecure === true)
  for (const key of ['device_id', 'token', 'local_token']) requireText(config[key], key, 256)
  if (!Array.isArray(config.runtimes) || !config.runtimes.length || new Set(config.runtimes).size !== config.runtimes.length || config.runtimes.some((r) => !['codex', 'harness'].includes(r))) throw fail('invalid-runtimes')
  if (!config.runtimes.includes('harness')) throw fail('worker-profile-does-not-provide-harness')
  config.cwd = realpathSync(config.cwd)
  if (!statSync(config.cwd).isDirectory()) throw fail('workspace-directory-required')
  return config
}

// Serialize ownership changes across plugin reloads and CLI processes. The PID file also
// prevents a running older CLI from being replaced. Ambiguous ownership is never stolen.
export function acquireWorker(home, kind) {
  mkdirSync(home, { recursive: true, mode: 0o700 })
  const path = join(home, 'worker.pid.json')
  const db = new DatabaseSync(join(home, 'worker-control.sqlite'))
  const token = randomUUID(); let recorded = false
  try {
    db.exec('PRAGMA busy_timeout=3000; CREATE TABLE IF NOT EXISTS owner (id INTEGER PRIMARY KEY CHECK(id=1), pid INTEGER NOT NULL, token TEXT NOT NULL); BEGIN IMMEDIATE')
    const previous = db.prepare('SELECT pid FROM owner WHERE id=1').get()
    if (previous && alive(previous.pid)) throw fail('worker-already-running-or-owner-unverifiable')
    assertWorkerStopped(home)
    if (existsSync(path)) unlinkSync(path)
    const fd = openSync(path, 'wx', 0o600)
    try { writeFileSync(fd, JSON.stringify({ pid: process.pid, token, kind })); recorded = true } finally { closeSync(fd) }
    db.prepare('INSERT OR REPLACE INTO owner VALUES(1,?,?)').run(process.pid, token)
    db.exec('COMMIT')
  } catch (error) {
    try { db.exec('ROLLBACK') } catch {}
    if (recorded) { try { if (JSON.parse(readFileSync(path, 'utf8')).token === token) unlinkSync(path) } catch {} }
    db.close(); throw error
  }
  let released = false
  const release = () => {
    if (released) return
    db.exec('BEGIN IMMEDIATE')
    try {
      const current = db.prepare('SELECT token FROM owner WHERE id=1').get()
      if (current?.token === token) {
        if (existsSync(path) && JSON.parse(readFileSync(path, 'utf8')).token === token) unlinkSync(path)
        db.prepare('DELETE FROM owner WHERE token=?').run(token)
      }
      db.exec('COMMIT'); released = true; db.close()
    } catch (error) { db.exec('ROLLBACK'); throw error }
  }
  release.publish = (controlPort, deviceId) => {
    const current = JSON.parse(readFileSync(path, 'utf8'))
    if (current.token !== token) throw fail('worker-owner-unverifiable')
    writeConfig(path, { ...current, control_port: controlPort, device_id: deviceId })
  }
  return release
}

export async function startWorkerRuntime({ home, kind = 'cli', onCreate = () => {} }) {
  home = resolve(home)
  const config = readWorkerConfig(home)
  const release = acquireWorker(home, kind)
  let worker, closing
  const close = () => closing ??= (async () => { try { await worker?.close() } finally { release() } })()
  try {
    // Never drop an execution that the retired runtime might already have started.
    const ledger = new DatabaseSync(join(home, config.database || 'worker.sqlite'))
    try {
      const hasRecords = ledger.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='records'").get()
      if (hasRecords) {
        const active = ledger.prepare("SELECT value FROM records WHERE bucket='tasks'").all().map((r) => JSON.parse(r.value))
        if (active.some((t) => t.runtime && t.runtime !== 'harness' && !TERMINAL.has(t.status))) throw fail('legacy-runtime-tasks-require-review')
      }
    } finally { ledger.close() }
    if (config.runtimes.length !== 1 || config.codex) {
      const path = join(home, 'config.json')
      if (!existsSync(join(home, 'legacy-runtime-config.json'))) writeConfig(join(home, 'legacy-runtime-config.json'), JSON.parse(readFileSync(path, 'utf8')))
      config.runtimes = ['harness']; delete config.codex
      writeConfig(path, config)
    }
    const adapters = { harness: new HarnessBridge() }
    if (kind === 'plugin' && autostartRegistration(home)) removeAutostart(home)
    worker = new Worker({ dbPath: join(home, config.database || 'worker.sqlite'), config, adapters, localPort: config.local_port, home, onUnpaired: () => { void close().catch(() => {}) } })
    onCreate(worker)
    await worker.start()
    release.publish(worker.server.address().port, config.device_id)
  } catch (error) {
    try { await worker?.close() } finally { release() }
    throw error
  }
  return { worker, config, close }
}
