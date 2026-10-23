import { resolve } from 'node:path'
import { realpathSync } from 'node:fs'
// Harness 0.2.1-rc.2 caches metadata across package upgrades. Refresh only this
// plugin when its client first appears or its installed source directory changes.
export function ensureClientRegistration(ctx) {
  ctx.inject(['clientModules'], (scope) => {
    const registry = scope.clientModules
    const current = registry.clientPath?.('dsh-agent-hub')
    const expected = resolve(import.meta.dirname, 'client.js')
    const canonical = (path) => { try { return realpathSync(path).toLowerCase() } catch { return resolve(path).toLowerCase() } }
    if (current && canonical(current) === canonical(expected)) {
      // Harness publishes a new artifact revision without dropping the graph row.
      // This also works when every update uses the same installation directory.
      registry.rebuilt?.('dsh-agent-hub')
      return
    }
    if (!registry.pkgMeta?.keys || !registry.dirty?.add || typeof registry.flush !== 'function') return
    if (current && !registry.table?.delete) return
    let removed = false
    for (const key of registry.pkgMeta.keys()) {
      if (key.endsWith('\0dsh-agent-hub')) { registry.pkgMeta.delete(key); removed = true }
    }
    if (removed) {
      registry.table?.delete('dsh-agent-hub')
      registry.dirty.add('dsh-agent-hub')
      registry.flush(() => { scope.logger?.warn?.('Agent Hub: client registration requires reopening Harness') })
    }
  })
}
