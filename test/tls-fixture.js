import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { temp } from './helpers.js'

// Each test process owns its certificate. No private key is committed or packaged.
let fixture
export function testTLS() {
  if (fixture) return fixture
  const directory = temp()
  const certFile = join(directory, 'server-cert.pem'), keyFile = join(directory, 'server-key.pem')
  const gitOpenSSL = join(process.env.ProgramFiles || 'C:/Program Files', 'Git/usr/bin/openssl.exe')
  const openssl = process.env.AGENT_HUB_OPENSSL || (process.platform === 'win32' && existsSync(gitOpenSSL) ? gitOpenSSL : 'openssl')
  const result = spawnSync(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', certFile, '-days', '2', '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost'], { encoding: 'utf8', windowsHide: true })
  if (result.error || result.status !== 0) throw new Error('TLS tests require OpenSSL 1.1.1+: set AGENT_HUB_OPENSSL to the executable path. ' + (result.error?.message || result.stderr))
  fixture = { certFile, keyFile }
  return fixture
}
