// Only remove old registrations. Harness owns the current Worker lifecycle.
import { existsSync, unlinkSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fail } from './util.js'
export function autostartPaths(home, platform = process.platform, env = process.env) {
  const id = 'agent-hub-worker-' + createHash('sha256').update(resolve(home)).digest('hex').slice(0, 12)
  const userHome = env.HOME || env.USERPROFILE || homedir()
  if (platform === 'win32') return { id, entry: join(env.APPDATA || join(userHome, 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', id + '.vbs'), launcher: join(home, 'autostart-run.ps1') }
  if (platform === 'darwin') return { id, entry: join(userHome, 'Library', 'LaunchAgents', id + '.plist') }
  if (platform === 'linux') return { id, entry: join(env.XDG_CONFIG_HOME || join(userHome, '.config'), 'systemd', 'user', id + '.service') }
  throw fail('unsupported-autostart-platform')
}
export function autostartRegistration(home) {
  for (const file of ['autostart-v2.json', 'autostart.json']) if (existsSync(join(home, file))) return JSON.parse(readFileSync(join(home, file), 'utf8'))
  return null
}
export function removeAutostart(home, { platform = process.platform, env = process.env, runner = spawnSync } = {}) {
  const paths = autostartPaths(home, platform, env)
  if (platform === 'linux') runner('systemctl', ['--user', 'disable', paths.id + '.service'], { encoding: 'utf8', windowsHide: true })
  if (platform === 'darwin') runner('launchctl', ['bootout', 'gui/' + process.getuid() + '/' + paths.id], { encoding: 'utf8' })
  // Disable future launches; a running task is allowed to finish in the current Worker.
  for (const path of [paths.entry, join(home, 'autostart.json'), join(home, 'autostart-v2.json')]) if (existsSync(path)) unlinkSync(path)
  return { installed: false }
}
