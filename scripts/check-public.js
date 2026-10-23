import assert from 'node:assert/strict'
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

export const publicEntries = [
  'src', 'bin', 'scripts', 'test', 'docs', 'assets', '.github',
  '.gitignore', '.gitattributes', '.editorconfig', 'package.json', 'pnpm-lock.yaml',
  'cordis.patch.yml', 'deployment.json', 'deployment.example.json', 'distribution.json',
  'README.md', 'README.en.md', 'CONTRIBUTING.md', 'SECURITY.md', 'LICENSE',
]

export function publicFiles(root) {
  function walk(path) {
    const stat = lstatSync(join(root, path))
    assert.ok(!stat.isSymbolicLink(), 'Public source must not contain symlinks: ' + path)
    return stat.isDirectory() ? readdirSync(join(root, path)).flatMap(name => walk(join(path, name))) : [path.replaceAll('\\', '/')]
  }
  return publicEntries.flatMap(walk).sort()
}

function checkImports(root, files) {
  const graph = new Map()
  for (const file of files.filter(f => /^(src|bin)\/.*\.js$/.test(f))) {
    const imports = [...readFileSync(join(root, file), 'utf8').matchAll(/\bfrom\s+['"]([^'"]+)['"]|\bimport\s+['"]([^'"]+)['"]/g)].map(m => m[1] || m[2])
    const dependencies = imports.filter(p => p.startsWith('.')).map(p => {
      const target = resolve(root, dirname(file), p)
      assert.ok(existsSync(target), 'Missing local import in ' + file)
      return relative(root, target).replaceAll('\\', '/')
    })
    graph.set(file, dependencies)
  }
  const checked = new Set()
  function visit(file, trail = []) {
    assert.ok(!trail.includes(file), 'Circular local import: ' + [...trail, file].join(' -> '))
    if (checked.has(file)) return
    for (const dependency of graph.get(file) || []) visit(dependency, [...trail, file])
    checked.add(file)
  }
  for (const file of graph.keys()) visit(file)
}

export function checkPublic(root, { tracked = false } = {}) {
  let files = publicFiles(root)
  if (tracked) {
    const git = spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', windowsHide: true })
    assert.equal(git.status, 0, 'A Git checkout is required for --tracked')
    const allowed = new Set(files)
    files = git.stdout.split('\0').filter(Boolean)
    assert.ok(files.length > 0, 'No tracked files to audit')
    for (const file of files) assert.ok(allowed.has(file), 'File outside the public allowlist: ' + file)
  }
  for (const file of files) {
    assert.ok(!/(?:^|\/)(?:node_modules|\.work|backups|dist)(?:\/|$)|\.(?:pem|key|pfx|p12|sqlite[^/]*|log)$/i.test(file), 'Operator data or key in public source: ' + file)
    const text = readFileSync(join(root, file), 'utf8')
    assert.ok(!/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/.test(text), 'Private key in ' + file)
    assert.ok(!/\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|sk-[A-Za-z0-9_-]{32,})\b/.test(text), 'Possible credential in ' + file)
    assert.ok(!/[A-Za-z]:[\\/]Users[\\/](?!PUBLIC|YOUR_USER|<)[^\\/\s'"`]+[\\/]/i.test(text), 'Personal absolute path in ' + file)
    for (const match of text.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g)) {
      const ip = match[0]
      assert.ok(/^(?:127\.|0\.0\.0\.0$|203\.0\.113\.|198\.51\.100\.|192\.0\.2\.)/.test(ip), 'Non-example IP address in ' + file)
    }
    if (!file.endsWith('.md')) continue
    for (const match of text.matchAll(/\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)) {
      const target = match[1].split('#')[0]
      if (!target || /^(?:[a-z]+:|\/)/i.test(target)) continue
      const destination = resolve(root, dirname(file), decodeURIComponent(target))
      assert.ok(destination.startsWith(resolve(root) + sep) && existsSync(destination), 'Broken local link in ' + file + ': ' + target)
    }
  }
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  assert.equal(pkg.name, 'dsh-agent-hub')
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.ok(pkg.dsh.profile.bundles.includes(pkg.name))
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  for (const entry of [pkg.main, ...Object.values(pkg.exports), ...Object.values(pkg.bin), ...pkg.files]) assert.ok(existsSync(resolve(root, entry)), 'Missing package entry: ' + entry)
  assert.ok(pkg.files.includes('README.md') && pkg.files.includes('README.en.md'))
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'deployment.json'), 'utf8')), {}, 'Public deployment defaults must remain empty')
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'distribution.json'), 'utf8')).runtimes, ['harness'])
  checkImports(root, files)
  console.log(`Public source, DSH package contract, import graph and document links passed (${files.length} files)`)
  return files
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  checkPublic(resolve(import.meta.dirname, '..'), { tracked: process.argv.includes('--tracked') })
}
