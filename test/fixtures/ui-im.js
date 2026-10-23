import { join } from 'node:path'
import { writeConfig } from '../../src/util.js'
export const name = 'agent-hub-ui-fake-im'
export const inject = ['sessionController', 'sessionPersistence', 'typertGateway', 'connection']
export async function apply(ctx) {
  const home = process.env.DSH_HOME
  const peer = ctx.connection.createPeer({ principal: { kind: 'owner' }, interactions: 'none' })
  const result = await ctx.typertGateway.invoke({ namespace: 'session', method: 'create', args: { request: { cwd: home } }, peer })
  await ctx.typertGateway.invoke({ namespace: 'session', method: 'rename', args: { request: { sessionId: result.sessionId, title: 'UI 验证主会话' } }, peer })
  await ctx.sessionPersistence.flush(); peer.dispose()
  writeConfig(join(home, 'ui-session.json'), { sessionId: result.sessionId })
  writeConfig(join(home, 'integrations/dsh-weixin/workspaces.json'), { deliveryTargets: { wx_smoke: { ui_target: { sessionSync: { conversationKey: 'p2p:ui-smoke' } } } } })
  writeConfig(join(home, 'integrations/dsh-weixin/accounts/wx_smoke/state.json'), { sessions: { 'p2p:ui-smoke': result.sessionId } })
  ctx.provide('dshIm', { send: async () => { throw Error('No WeChat delivery in UI smoke') }, listBots: async () => [{ channel: 'weixin', botId: 'wx_smoke' }], listTargets: async () => [{ targetId: 'ui_target', name: 'UI 验证微信目标', kind: 'user', sessionSync: { enabled: true } }] })
}
