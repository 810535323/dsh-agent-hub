import http from 'node:http'
import https from 'node:https'
import { readFileSync } from 'node:fs'
import { fail } from './util.js'
import { MAX_FRAME } from './protocol.js'

export function isLoopback(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

export function hubUrl(raw, allowInsecure = false) {
  const url = new URL(raw)
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw fail('invalid-hub-url')
  if (url.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && !allowInsecure) throw fail('https-required')
  return url.origin
}

export function clientTLS(config) {
  return config.ca_file ? { ca: readFileSync(config.ca_file) } : {}
}

// The same explicit trust anchor is used for enrollment and the long-lived WSS connection.
// Do not disable certificate or hostname verification for IP-address connections.
export function postJson(url, payload, tls = {}) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(payload))
    const transport = new URL(url).protocol === 'https:' ? https : http
    const request = transport.request(url, { ...tls, method: 'POST', headers: { ...tls.headers, 'Content-Type': 'application/json', 'Content-Length': data.length } }, (response) => {
      const chunks = []; let size = 0
      response.on('data', (chunk) => {
        size += chunk.length
        if (size > MAX_FRAME) response.destroy(fail('body-too-large'))
        else chunks.push(chunk)
      })
      response.on('error', reject)
      response.on('end', () => {
        try { resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }) }
        catch { reject(fail('invalid-hub-response')) }
      })
    })
    request.setTimeout(10000, () => request.destroy(fail('hub-request-timeout')))
    request.on('error', reject)
    request.end(data)
  })
}
