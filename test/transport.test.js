import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { copyFileSync, readFileSync, unlinkSync } from 'node:fs'
import { Hub } from '../src/hub.js'
import { Worker } from '../src/worker.js'
import { hubUrl, clientTLS, postJson } from '../src/transport.js'
import { temp, until, FakeAdapter, FakeHarnessContext } from './helpers.js'
import { startHarnessWorker } from '../src/harness-plugin.js'
import { testTLS } from './tls-fixture.js'

const tls = testTLS()

test('direct IP HTTPS enrollment and WSS execution use the same trusted certificate', async (t) => {
  const dir = temp(t)
  const hub = await new Hub({ dbPath: join(dir, 'hub.sqlite'), adminToken: 'admin', port: 0, tls }).listen()
  let worker
  t.after(async () => { await worker?.close(); await hub.close() })
  const url = 'https://127.0.0.1:' + hub.server.address().port
  hub.bindMaster({ session_id: 'master', bot_id: 'wx', target_id: 'person' })
  const pair = hub.createPair('master')
  await assert.rejects(postJson(url + '/v2/enroll', { code: pair.code, name: 'untrusted' }), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' })
  const trusted = clientTLS({ ca_file: tls.certFile })
  await assert.rejects(postJson(url + '/v2/enroll', { code: pair.code, name: 'wrong host' }, { ...trusted, servername: 'wrong.example' }), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' })
  const enrolled = await postJson(url + '/v2/enroll', { code: pair.code, name: 'IP worker' }, trusted)
  assert.equal(enrolled.status, 200)
  assert.equal(enrolled.body.ok, true)
  const config = { hub: url, ...enrolled.body, local_token: 'local', cwd: dir, ca_file: tls.certFile }
  const adapter = new FakeAdapter()
  worker = await new Worker({ dbPath: join(dir, 'worker.sqlite'), config, adapters: { harness: adapter }, localPort: 0 }).start()
  await until(() => hub.isOnline(config.device_id))
  const task = hub.dispatch('master', { endpoint_id: config.device_id + ':harness', prompt: 'TLS task' })
  await until(() => adapter.runs.length === 1)
  adapter.finish(task.id, { status: 'completed', answer: 'encrypted result', execution_summary: { exit_codes: [0] } })
  await until(() => hub.task('master', task.id).status === 'completed' && worker.store.pending().length === 0)
  assert.equal(hub.task('master', task.id).result.answer, 'encrypted result')
})

test('public listener rejects management APIs even with the valid admin credential', async (t) => {
  const hub = new Hub({ dbPath: join(temp(t), 'hub.sqlite'), adminToken: 'correct', tls })
  try {
    for (const [method, url] of [['GET', '/v2/devices'], ['POST', '/v2/master'], ['POST', '/v2/pair']]) {
      let status; let result
      await hub.handleHttp({ method, url, headers: { authorization: 'Bearer correct' }, socket: { encrypted: true, remoteAddress: '203.0.113.15' } }, {
        writeHead: (s) => { status = s }, end: (body) => { result = JSON.parse(body) },
      })
      assert.equal(status, 403)
      assert.equal(result.error, 'local-admin-only')
    }
    let status
    await hub.handleHttp({ method: 'POST', url: '/v2/enroll', socket: { remoteAddress: '203.0.113.15' } }, { writeHead: (s) => { status = s }, end() {} })
    assert.equal(status, 403)
    assert.equal(hub.store.all('masters').length, 0)
  } finally { await hub.close() }
})

test('IP addresses work without a domain; cleartext remote transport requires an explicit option', () => {
  assert.equal(hubUrl('https://203.0.113.10:9443'), 'https://203.0.113.10:9443')
  assert.throws(() => hubUrl('http://203.0.113.10:9443'), /https-required/)
  assert.equal(hubUrl('http://203.0.113.10:9443', true), 'http://203.0.113.10:9443')
  assert.throws(() => hubUrl('https://203.0.113.10:9443/nested'), /invalid-hub-url/)
})

test('CLI pairing saves its CA certificate and reconnects with it after restart', async (t) => {
  const dir = temp(t)
  const home = join(dir, 'worker-home'); const incomingCA = join(dir, 'downloaded-cert.pem')
  copyFileSync(tls.certFile, incomingCA)
  const hub = await new Hub({ dbPath: join(dir, 'hub.sqlite'), adminToken: 'admin', port: 0, tls }).listen()
  const url = 'https://127.0.0.1:' + hub.server.address().port
  hub.bindMaster({ session_id: 'master', bot_id: 'wx', target_id: 'person' })
  let child, plugin
  const stop = async () => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return
    const exited = once(child, 'close'); child.kill('SIGTERM'); await exited
  }
  t.after(async () => { await stop(); await plugin?.close(); await hub.close() })
  const launch = (args) => {
    child = spawn(process.execPath, [fileURLToPath(new URL('../bin/agent-hub.js', import.meta.url)), ...args, '--home', home], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.resume(); child.stderr.resume()
  }
  launch(['pair', '--hub', url, '--ca-file', incomingCA, '--code', hub.createPair('master').code, '--cwd', dir, '--runtimes', 'harness', '--local-port', '0'])
  await once(child, 'close')
  assert.equal(child.exitCode, 0)
  const ctx = new FakeHarnessContext()
  plugin = startHarnessWorker(ctx, { workerHome: home })
  await until(() => hub.listDevices('master')[0]?.endpoints[0]?.ready)
  const saved = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'))
  assert.notEqual(saved.ca_file, incomingCA)
  assert.deepEqual(readFileSync(saved.ca_file), readFileSync(incomingCA))
  await plugin.close()
  await until(() => !hub.isOnline(saved.device_id))
  unlinkSync(incomingCA)
  plugin = startHarnessWorker(ctx, { workerHome: home })
  await until(() => hub.isOnline(saved.device_id) && hub.listDevices('master')[0]?.endpoints[0]?.ready)
  assert.equal(hub.listDevices('master').length, 1)
})
