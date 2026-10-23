// Explicit certificate pinning for public release downloads from a self-signed IP endpoint.
// No enrollment or device credentials are sent by this downloader.
import https from 'node:https'
import tls from 'node:tls'
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'

export function downloadPinned(url, fingerprint, sha256) {
  const address = new URL(url)
  if (address.protocol !== 'https:' || address.username || address.password) throw new Error('https-url-required')
  const agent = new https.Agent()
  agent.createConnection = (options, callback) => {
    const socket = tls.connect({ ...options, rejectUnauthorized: false })
    const failed = (error) => { socket.destroy(); callback(error) }
    socket.once('error', failed)
    socket.once('secureConnect', () => {
      const certificate = socket.getPeerCertificate()
      const mismatch = tls.checkServerIdentity(address.hostname, certificate)
      if (mismatch || certificate.fingerprint256?.replaceAll(':', '').toLowerCase() !== fingerprint.replaceAll(':', '').toLowerCase()) return failed(new Error('certificate-pin-mismatch'))
      socket.removeListener('error', failed)
      callback(null, socket)
    })
    // HTTP is admitted only after both hostname and the out-of-band pin match.
  }
  return new Promise((resolve, reject) => {
    const request = https.get(address, { agent }, (response) => {
      if (response.statusCode !== 200) { response.resume(); reject(new Error('download-http-' + response.statusCode)); return }
      const chunks = []; let size = 0
      response.on('data', (chunk) => { size += chunk.length; if (size > 20 * 1024 * 1024) response.destroy(new Error('release-too-large')); else chunks.push(chunk) })
      response.on('error', reject)
      response.on('end', () => {
        const body = Buffer.concat(chunks)
        if (createHash('sha256').update(body).digest('hex') !== sha256.toLowerCase()) reject(new Error('release-checksum-mismatch'))
        else resolve(body)
      })
    })
    request.setTimeout(15000, () => request.destroy(new Error('download-timeout')))
    request.on('error', reject)
  }).finally(() => agent.destroy())
}
if (import.meta.main) {
  const [url, fingerprint, sha256, output] = process.argv.slice(2)
  if (!url || !fingerprint || !sha256 || !output) throw new Error('Usage: node scripts/fetch-release.js URL CERT_SHA256 ZIP_SHA256 OUTPUT')
  writeFileSync(output, await downloadPinned(url, fingerprint, sha256))
  console.log('Release certificate and checksum verified: ' + output)
}
