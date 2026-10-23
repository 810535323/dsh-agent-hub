import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { postJson, clientTLS } from './transport.js'
import { removeAutostart } from './autostart.js'
import { fail, writeConfig } from './util.js'

export async function requestUnpair(config) {
  const response = await postJson(config.hub + '/v2/device/unpair', { device_id: config.device_id }, {
    ...clientTLS(config), headers: { Authorization: 'Bearer ' + config.token },
  })
  const receipt = response.body.receipt
  if (response.status !== 200 || !response.body.ok) throw fail(response.body.error || 'unpair-failed')
  if (receipt?.device_id !== config.device_id || !receipt.receipt_id || !receipt.revoked_at) throw fail('invalid-unpair-receipt')
  return receipt
}

export function finishUnpair(home, config, receipt, autostartOptions) {
  if (receipt.device_id !== config.device_id) throw fail('invalid-unpair-receipt')
  const path = join(home, 'config.json')
  if (existsSync(path) && JSON.parse(readFileSync(path, 'utf8')).device_id !== config.device_id) throw fail('binding-changed')
  // Persist the host's revocation receipt before forgetting the local credentials.
  writeConfig(join(home, 'last-unpair.json'), receipt)
  if (existsSync(join(home, 'autostart.json')) || existsSync(join(home, 'autostart-v2.json'))) removeAutostart(home, autostartOptions)
  if (existsSync(path)) {
    unlinkSync(path)
  }
  // Native Sessions, SQLite task ledgers, outbox and receipts remain on this device.
  return { unpaired: true, ...receipt }
}
