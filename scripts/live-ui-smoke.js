// Real Harness + real Chromium test, isolated from personal accounts and model inference.
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, symlinkSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { WebSocket } from 'ws'
import { pairWorker } from '../src/pairing.js'
import { postJson } from '../src/transport.js'
const root = resolve(import.meta.dirname, '..')
const executable = process.env.AGENT_HUB_DSH_EXE || 'C:/DSH/DeepSeek Harness.exe'
const edge = process.env.AGENT_HUB_EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
mkdirSync(join(root, '.work'), { recursive: true })
const home = mkdtempSync(join(root, '.work/ui-host-'))
const profile = join(home, 'profiles/web'); mkdirSync(join(profile, 'node_modules'), { recursive: true })
symlinkSync(root, join(profile, 'node_modules/dsh-agent-hub'), 'junction')
writeFileSync(join(profile, 'package.json'), JSON.stringify({ dependencies: { 'dsh-agent-hub': 'link:' + root.replaceAll('\\', '/') }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-agent-hub'] } } }))
writeFileSync(join(profile, 'cordis.yml'), '[]\n')
writeFileSync(join(profile, 'cordis.patch.yml'), `- id: webserver\n  config:\n    host: 127.0.0.1\n    port: 0\n- id: session-telemetry-otel\n  disabled: true\n- id: session-title-llm\n  disabled: true\n- id: agent-hub\n  config:\n    role: hub\n    port: 0\n    workerLocalPort: 0\n    dataDir: '${join(home, 'hub').replaceAll('\\', '/')}'\n    workerHome: '${join(home, 'worker').replaceAll('\\', '/')}'\n- insert:\n    - id: ui-fake-im\n      name: '${join(root, 'test/fixtures/ui-im.js').replaceAll('\\', '/')}'\n    - id: ui-smoke\n      name: '${join(root, 'test/fixtures/ui-host.js').replaceAll('\\', '/')}'\n`)
const cli = join(dirname(executable), 'resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js')
let logs = '', browser, socket, sequence = 0
const host = spawn(executable, ['--expose-internals', cli, '--profile', 'web', '--no-open'], { cwd: home, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: home }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
host.stdout.on('data', (c) => { logs += c }); host.stderr.on('data', (c) => { logs += c })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(check, timeout = 20000) { const end = Date.now() + timeout; while (Date.now() < end) { const value = await check(); if (value) return value; if (host.exitCode !== null) throw Error('Native Host exited: ' + logs.slice(-5000).replace(/token=[^\s]+/g, 'token=***')); await sleep(100) }; throw Error('UI smoke timed out') }
const pending = new Map()
function cdp(method, params = {}) { const id = ++sequence; return new Promise((resolve, reject) => { const timer = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout: ' + method)) }, 12000); pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params })) }) }
async function evaluate(expression) { const r = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw Error(r.exceptionDetails.text + ': ' + JSON.stringify(r.exceptionDetails.exception)); return r.result?.value }
async function click(text) { return evaluate(`(()=>{const text=${JSON.stringify(text)};const b=[...document.querySelectorAll('button,[role="tab"],[role="menuitem"],[role="button"]')].find(e=>e.textContent.trim()===text||(text==='设置'&&e.textContent.trim().startsWith(text))||e.getAttribute('aria-label')===text||e.title===text);if(!b||b.disabled)return false;b.click();return true})()` ) }
async function field(label, value) { return evaluate(`(()=>{const value=${JSON.stringify(value)};const label=[...document.querySelectorAll('.ah-field')].find(e=>e.querySelector('span')?.textContent===${JSON.stringify(label)});const e=label?.querySelector('input,select,textarea');if(!e||(e.tagName==='SELECT'&&![...e.options].some(o=>o.value===value)))return false;const proto=e.tagName==='SELECT'?HTMLSelectElement.prototype:e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(e,value);e.dispatchEvent(new Event(e.tagName==='SELECT'?'change':'input',{bubbles:true}));return true})()` ) }
try {
  await until(() => existsSync(join(home, 'ui-boot.json')))
  const boot = JSON.parse(readFileSync(join(home, 'ui-boot.json'), 'utf8'))
  if (!boot.client_registered) throw Error('Client module is absent from the native graph')
  const browserProfile = join(home, 'browser')
  browser = spawn(edge, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--disable-background-networking', '--remote-debugging-port=0', '--window-size=1440,1100', '--user-data-dir=' + browserProfile, boot.url], { windowsHide: true, stdio: 'ignore' })
  await until(() => existsSync(join(browserProfile, 'DevToolsActivePort')))
  const port = readFileSync(join(browserProfile, 'DevToolsActivePort'), 'utf8').split('\n')[0]
  const target = await until(async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page' && t.webSocketDebuggerUrl && t.url.startsWith(new URL(boot.url).origin)))
  socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((r, reject) => { socket.once('open', r); socket.once('error', reject) })
  socket.on('message', (raw) => { const m = JSON.parse(raw); const p = pending.get(m.id); if (!p) return; pending.delete(m.id); clearTimeout(p.timer); m.error ? p.reject(Error(JSON.stringify(m.error))) : p.resolve(m.result) })
  await cdp('Page.enable'); await cdp('Runtime.enable')
  await until(async () => (await evaluate('document.body?.innerText || ""')).length > 50)
  await sleep(1500)
  await click('继续')
  await sleep(400)
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  const opened = await click('设置')
  if (!opened) await click('账号菜单')
  if (!opened && !await until(() => click('设置'), 5000)) {
    const buttons = await evaluate('[...document.querySelectorAll("button")].map(b=>({text:b.textContent.trim().slice(0,40),aria:b.getAttribute("aria-label"),title:b.title}))')
    writeFileSync(join(home, 'buttons.json'), JSON.stringify(buttons, null, 2))
    throw Error('Cannot find native Settings button; inspect ' + home)
  }
  await until(() => click('Agent Hub 设备'))
  await until(() => evaluate('!!document.querySelector("[data-agent-hub-page=hub]")'))
  await until(() => field('微信目标', 'wx_smoke/ui_target'))
  await until(() => evaluate('!![...document.querySelectorAll("button")].find(b=>b.textContent==="保存主会话"&&!b.disabled)'))
  await click('保存主会话'); await until(() => evaluate('document.body.innerText.includes("微信主会话已绑定")'))
  await until(() => evaluate('document.querySelector("[data-testid=pending-reports]")?.innerText.includes("task-ui-result")&&document.querySelector("[data-testid=pending-reports]").innerText.includes("发送结果待核查")'))
  await click('生成配对码'); await until(() => evaluate('document.querySelector("[data-testid=pair-code]")?.textContent.length===12'))
  const demoCode = await evaluate('document.querySelector("[data-testid=pair-code]").textContent')
  await pairWorker(join(home, 'demo-worker'), { hub: boot.plugin_hub, code: demoCode, name: 'UI 验证从机', cwd: home, runtimes: ['harness'], local_port: 0 })
  await until(() => evaluate('document.body.innerText.includes("入口就绪")&&document.body.innerText.includes("设备已完成配对")'))
  let screenshot = await cdp('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(home, 'master.png'), Buffer.from(screenshot.data, 'base64'))
  await click('解绑设备'); await click('确认解绑设备')
  await until(() => evaluate('document.body.innerText.includes("设备已解绑，旧凭据已撤销")&&!document.querySelector(".ah-device:not(.ah-report)")'))
  await evaluate('[...document.querySelectorAll("details")].find(e=>e.querySelector("summary")?.textContent==="插件角色与连接设置").open=true')
  await click('切换为从机'); await until(() => evaluate('!!document.querySelector("[data-agent-hub-page=harness]")'))
  await field('主机地址', boot.worker_hub); await field('配对码', boot.worker_code); await field('本机工作目录', boot.cwd)
  await click('绑定并自动连接'); await until(() => evaluate('document.body.innerText.includes("已连接主机")'), 25000)
  await click('检查通信'); await until(() => evaluate('document.body.innerText.includes("通信正常")'))
  await field('固定会话', boot.session_id); await click('保存会话绑定'); await until(() => evaluate('document.body.innerText.includes("固定会话已保存")'))
  screenshot = await cdp('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(home, 'worker.png'), Buffer.from(screenshot.data, 'base64'))
  const replacement = await postJson(boot.worker_hub + '/v2/pair', { master_id: boot.session_id }, { headers: { Authorization: 'Bearer smoke-only' } })
  const cli = spawn(process.execPath, [join(root, 'bin/agent-hub.js'), 'pair', '--home', join(home, 'worker'), '--hub', boot.worker_hub, '--code', replacement.body.code, '--cwd', boot.cwd, '--runtimes', 'harness', '--replace', '--no-start'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  cli.stdout.resume(); cli.stderr.resume()
  const code = await new Promise((resolve) => cli.once('close', resolve))
  if (code !== 0) throw Error('Native plugin CLI replacement failed')
  await click('刷新')
  await until(() => evaluate('document.body.innerText.includes("已连接主机")'))
  await click('解绑主机'); await click('确认解绑主机')
  await until(() => evaluate('document.body.innerText.includes("已解绑主机，固定会话和任务记录已保留")&&!![...document.querySelectorAll("button")].find(b=>b.textContent==="绑定并自动连接")'))
  console.log('Native UI passed: pairing, checks, Session binding, real CLI --replace through native plugin ownership and unpair flows. Screenshots: ' + home)
} catch (error) {
  if (socket?.readyState === WebSocket.OPEN) {
    try { const capture = await cdp('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(home, 'failure.png'), Buffer.from(capture.data, 'base64')); writeFileSync(join(home, 'failure-dom.txt'), String(await evaluate('document.body?.innerText || ""'))) } catch {}
  }
  console.error('UI smoke artifacts: ' + home)
  throw error
} finally {
  socket?.close(); browser?.kill(); writeFileSync(join(home, 'ui-finish'), 'done')
  await until(() => host.exitCode !== null, 8000).catch(() => { host.kill() })
  writeFileSync(join(home, 'host.log'), logs)
}
