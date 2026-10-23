import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { createHash, X509Certificate } from 'node:crypto'
import { Hub } from '../src/hub.js'
import { downloadPinned } from '../scripts/fetch-release.js'
import { temp } from './helpers.js'
import { testTLS } from './tls-fixture.js'

test('release listener exposes only allowlisted artifacts; pinned TLS and artifact hashes must both match', async (t) => {
  const dir = temp(t), releases = join(dir, 'releases'); mkdirSync(releases)
  const content = Buffer.from('public distribution, no credentials')
  const hash = createHash('sha256').update(content).digest('hex')
  writeFileSync(join(releases, 'worker.zip'), content)
  writeFileSync(join(releases, 'private.txt'), 'NEVER_RETURN')
  writeFileSync(join(releases, 'index.json'), JSON.stringify({ version: '0.3.0', files: [{ name: 'worker.zip', sha256: hash, size: content.length }] }))
  const { certFile, keyFile } = testTLS()
  const hub = await new Hub({ dbPath: join(dir, 'hub.sqlite'), port: 0, adminToken: 'secret', releaseDir: releases, tls: { certFile, keyFile } }).listen()
  t.after(() => hub.close())
  const url = 'https://127.0.0.1:' + hub.server.address().port
  const pin = new X509Certificate(readFileSync(certFile)).fingerprint256
  assert.deepEqual(await downloadPinned(url + '/releases/worker.zip', pin, hash), content)
  await assert.rejects(downloadPinned(url + '/releases/private.txt', pin, hash), /download-http-404/)
  await assert.rejects(downloadPinned(url + '/releases/worker.zip', '00'.repeat(32), hash), /certificate-pin-mismatch/)
  await assert.rejects(downloadPinned(url + '/releases/worker.zip', pin, '00'.repeat(32)), /release-checksum-mismatch/)
})
