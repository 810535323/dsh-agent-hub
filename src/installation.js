import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fail } from './util.js'

export function distribution(root = resolve(import.meta.dirname, '..')) {
  const path = join(root, 'distribution.json')
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { kind: 'harness-plugin', runtimes: ['harness'] }
}

export function dataHome({ userHome = homedir(), env = process.env } = {}) {
  const base = env.DSH_HOME || join(userHome, '.dsh')
  const current = join(base, 'agent-hub'), legacy = join(base, 'agent-hub-v2')
  // Keep the existing database and credentials in place. New installs use a stable name.
  if (existsSync(join(current, 'config.json')) || existsSync(join(current, 'plugin-settings.json'))) return current
  return existsSync(join(legacy, 'config.json')) || existsSync(join(legacy, 'plugin-settings.json')) ? legacy : current
}

export function workerHome(kind, { userHome = homedir(), env = process.env } = {}) {
  if (kind !== 'harness') throw fail('harness-only-use-local-subagent')
  const scoped = env.AGENT_HUB_HARNESS_WORKER_HOME
  if (scoped) return resolve(scoped)
  const target = join(dataHome({ userHome, env }), 'worker')
  if (existsSync(join(target, 'config.json'))) return resolve(target)
  // Adopt a legacy binding in place only when this runtime can actually own it.
  // Never copy its token/ledger into a second installation.
  const legacy = env.AGENT_HUB_WORKER_HOME || join(userHome, '.agent-hub-worker')
  try {
    const config = JSON.parse(readFileSync(join(legacy, 'config.json'), 'utf8'))
    if (config.runtimes?.includes('harness')) return resolve(legacy)
  } catch {}
  return resolve(target)
}
