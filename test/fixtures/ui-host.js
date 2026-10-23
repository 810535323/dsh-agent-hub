import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Hub } from '../../src/hub.js'
import { writeConfig } from '../../src/util.js'
import { startHarnessWorker } from '../../src/harness-plugin.js'
export const name = 'agent-hub-ui-smoke'
export const inject = ['agentHub', 'dshIm', 'connection', 'webServer', 'clientModules', 'sessionPersistence']
export async function apply(ctx) {
  try {
    const home = process.env.DSH_HOME
    const controller = ctx.agentHub
    const result = JSON.parse(readFileSync(join(home, 'ui-session.json'), 'utf8'))
    const deadline = Date.now() + 10000
    while (!controller.master || !JSON.stringify(ctx.clientModules.graph()).includes('dsh-agent-hub')) { if (Date.now() > deadline) throw Error('Master or client graph did not become ready: ' + controller.phase + '/' + controller.error); await new Promise((r) => setTimeout(r, 25)) }
    if (!(await controller.sessions()).some((session) => session.id === result.sessionId)) throw Error('Native Session list omitted the test Session')
    // Exercise durable pending-result UI without running a real model or contacting WeChat.
    controller.master.coordinator.native.isIdle = async () => false
    const reportTimer = setInterval(() => {
      const master = controller.master
      if (!master?.hub.store.get('masters', result.sessionId)) return
      clearInterval(reportTimer)
      master.hub.store.put('tasks', { id: 'task-ui-result', master_id: result.sessionId, device_id: 'ui-history-only', status: 'completed', result_message_id: 'ui-result-revision', finished_at: new Date().toISOString(), result: { status: 'completed', answer: 'UI 测试：此结果保持待处理，发送结果不确定时不自动重发。' } })
      master.coordinator.tick()
    }, 100)
    ctx.effect(() => () => clearInterval(reportTimer))
    const workerHub = await new Hub({ dbPath: join(home, 'worker-test-hub.sqlite'), adminToken: 'smoke-only', port: 0 }).listen()
    const demoWorker = startHarnessWorker(controller.ctx, { workerHome: join(home, 'demo-worker') })
    workerHub.bindMaster({ session_id: result.sessionId, bot_id: 'never-send', target_id: 'never-send' })
    const boot = { url: ctx.connection.browserAuth.authenticatedUrl('http://127.0.0.1:' + ctx.webServer.port + '/'), plugin_hub: 'http://127.0.0.1:' + controller.master.hub.server.address().port, worker_hub: 'http://127.0.0.1:' + workerHub.server.address().port, worker_code: workerHub.createPair(result.sessionId).code, session_id: result.sessionId, cwd: home, client_registered: JSON.stringify(ctx.clientModules.graph()).includes('dsh-agent-hub') }
    writeConfig(join(home, 'ui-boot.json'), boot)
    const timer = setInterval(async () => {
      if (!existsSync(join(home, 'ui-finish'))) return
      clearInterval(timer)
      await demoWorker.close(); await controller.close(); await workerHub.close(); process.stdout.write('AGENT_HUB_UI_HOST_OK\n'); process.exit(0)
    }, 200)
  } catch (error) { process.stderr.write('UI_HOST_FAILED ' + String(error.stack) + '\n'); process.exit(1) }
}
