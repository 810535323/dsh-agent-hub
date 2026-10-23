import { randomBytes, createHash, timingSafeEqual } from 'node:crypto'
import { mkdirSync, writeFileSync, renameSync, chmodSync } from 'node:fs'
import { dirname } from 'node:path'

export const secret = () => randomBytes(32).toString('hex')
export const digest = (value) => createHash('sha256').update(String(value)).digest('hex')
export const sameSecret = (a, b) => typeof a === 'string' && typeof b === 'string' && timingSafeEqual(Buffer.from(digest(a)), Buffer.from(digest(b)))
export const now = () => new Date().toISOString()
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
export function fail(code, message = code) { return Object.assign(new Error(message), { code }) }
export function writeConfig(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temp = path + '.tmp'
  writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 })
  renameSync(temp, path)
  try { chmodSync(path, 0o600) } catch {}
}
export function safeError(error) {
  // Native errors may contain prompts, credentials or tool output. Only send classified codes.
  const code = String(error?.code || 'runtime-error')
  return /^[a-zA-Z0-9_/-]{1,100}$/.test(code) ? code : 'runtime-error'
}
export function requireText(value, name, max = 65536) {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > max) throw fail('invalid-' + name)
  return value
}
