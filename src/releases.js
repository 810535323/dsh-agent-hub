import { existsSync, readFileSync, realpathSync, statSync, createReadStream } from 'node:fs'
import { join, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'

export function releaseIndex(directory) {
  const path = join(directory, 'index.json')
  if (!existsSync(path)) return null
  const value = JSON.parse(readFileSync(path, 'utf8'))
  return { version: value.version, files: Array.isArray(value.files) ? value.files.map(({ name, sha256, size }) => ({ name, sha256, size })) : [] }
}
export async function serveRelease(req, res, directory) {
  const url = new URL(req.url, 'http://localhost')
  if (!url.pathname.startsWith('/releases/')) return false
  if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); res.end(); return true }
  const index = releaseIndex(directory)
  if (url.pathname === '/releases/index.json' && index) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(req.method === 'HEAD' ? undefined : JSON.stringify(index)); return true
  }
  const name = url.pathname.slice('/releases/'.length)
  if (!index || !/^[a-zA-Z0-9._-]+\.(zip|tgz|sha256|pem|txt)$/.test(name) || !index.files.some((f) => f.name === name)) { res.writeHead(404); res.end(); return true }
  const base = realpathSync(directory), path = realpathSync(join(base, name))
  if (!path.startsWith(base + sep) || !statSync(path).isFile()) { res.writeHead(404); res.end(); return true }
  const type = /\.(pem|txt|sha256)$/.test(name) ? 'text/plain; charset=utf-8' : 'application/octet-stream'
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': statSync(path).size, 'Content-Disposition': 'attachment; filename="' + name + '"', 'X-Content-Type-Options': 'nosniff' })
  if (req.method === 'HEAD') res.end(); else await pipeline(createReadStream(path), res)
  return true
}
