import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, chmodSync } from 'node:fs'
import { dirname } from 'node:path'

// Each logical update, event receipt and outgoing message is committed in one SQLite transaction.
export class Store {
  constructor(path) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(path)
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS records (bucket TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(bucket,id));
      CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      PRAGMA user_version=2;`)
    if (path !== ':memory:') { try { chmodSync(path, 0o600) } catch {} }
  }
  get(bucket, id) { const r = this.db.prepare('SELECT value FROM records WHERE bucket=? AND id=?').get(bucket, id); return r ? JSON.parse(r.value) : null }
  all(bucket) { return this.db.prepare('SELECT value FROM records WHERE bucket=? ORDER BY rowid').all(bucket).map((x) => JSON.parse(x.value)) }
  put(bucket, value) { this.db.prepare('INSERT INTO records VALUES(?,?,?) ON CONFLICT(bucket,id) DO UPDATE SET value=excluded.value').run(bucket, value.id, JSON.stringify(value)); return value }
  remove(bucket, id) { this.db.prepare('DELETE FROM records WHERE bucket=? AND id=?').run(bucket, id) }
  receipt(id) { const r = this.db.prepare('SELECT value FROM receipts WHERE id=?').get(id); return r ? JSON.parse(r.value) : null }
  received(message, value) { this.db.prepare('INSERT INTO receipts VALUES(?,?) ON CONFLICT(id) DO NOTHING').run(message.message_id, JSON.stringify(value)) }
  enqueue(message) { this.db.prepare('INSERT INTO outbox VALUES(?,?) ON CONFLICT(id) DO NOTHING').run(message.message_id, JSON.stringify(message)); return message }
  pending() { return this.db.prepare('SELECT value FROM outbox ORDER BY rowid').all().map((x) => JSON.parse(x.value)) }
  acknowledge(ack) {
    const r = this.db.prepare('SELECT value FROM outbox WHERE id=?').get(ack.payload?.ack_id)
    if (!r || ack.type !== 'ack' || ack.payload?.persisted !== true) return false
    const m = JSON.parse(r.value)
    if (ack.task_id !== m.task_id || ack.attempt_id !== m.attempt_id || ack.binding_version !== m.binding_version) return false
    this.transaction(() => {
      this.received({ message_id: 'ack:' + m.message_id }, { ...ack, acknowledged_at: new Date().toISOString() })
      this.db.prepare('DELETE FROM outbox WHERE id=?').run(m.message_id)
    })
    return true
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE')
    try { const result = fn(); this.db.exec('COMMIT'); return result } catch (e) { this.db.exec('ROLLBACK'); throw e }
  }
  close() { this.db.close() }
}
