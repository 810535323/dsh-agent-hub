// Optional development check against an installed Electron Harness, in an isolated DSH_HOME.
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, unlinkSync } from 'node:fs'
import { resolve, join, dirname } from 'node:path'
const executable = process.env.AGENT_HUB_DSH_EXE
if (!executable) throw new Error('Set AGENT_HUB_DSH_EXE to the installed DeepSeek Harness executable')
const root = resolve(import.meta.dirname, '..')
mkdirSync(join(root, '.work'), { recursive: true })
const home = mkdtempSync(join(root, '.work', 'native-harness-'))
const oldBinding = join(home, 'smoke-binding.json'); if (existsSync(oldBinding)) unlinkSync(oldBinding)
const oldWorkerBinding = join(home, 'smoke-worker-binding.json'); if (existsSync(oldWorkerBinding)) unlinkSync(oldWorkerBinding)
const patch = join(home, 'smoke.patch.yml')
const fixture = join(root, 'test', 'fixtures', 'harness-live.js').replaceAll('\\', '/')
writeFileSync(patch, `- id: webserver\n  config:\n    host: 127.0.0.1\n    port: 0\n- id: session-telemetry-otel\n  disabled: true\n- id: session-title-llm\n  disabled: true\n- insert:\n    - id: agent-hub-native-smoke\n      name: '${fixture}'\n`)
const cli = join(dirname(executable), 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js')
for (let stage = 0; stage < 2; stage++) {
  const result = spawnSync(executable, ['--expose-internals', cli, '--profile', 'web', '--patch', patch, '--no-open'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: home }, cwd: home,
    encoding: 'utf8', windowsHide: true, timeout: 30000,
  })
  writeFileSync(join(home, `smoke-${stage}.log`), (result.stdout || '') + '\n' + (result.stderr || ''))
  if (result.status !== 0 || !result.stdout?.includes('AGENT_HUB_NATIVE_HOST_OK')) {
    process.stderr.write(((result.stdout || '').slice(-6000) + (result.stderr || '').slice(-4000)).replace(/token=[^\s]+/g, 'token=***'))
    throw result.error || new Error('Native Harness smoke failed; see .work/native-harness logs')
  }
  console.log(result.stdout.split('\n').find((line) => line.includes('AGENT_HUB_NATIVE_HOST_OK')))
}
