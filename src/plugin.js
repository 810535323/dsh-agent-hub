import { PluginController } from './controller.js'
import { installManagement } from './management.js'
import { ensureClientRegistration } from './client-registration.js'

export { startHub } from './hub-runtime.js'

export const name = 'agent-hub'
export const inject = ['agents', 'sessions', 'tools', 'sessionController', 'typertGateway', 'connection', 'approval', 'sessionPersistence']
export function apply(ctx, config = {}) {
  ensureClientRegistration(ctx)
  const controller = new PluginController(ctx, config)
  installManagement(ctx, controller)
  ctx.provide('agentHub', controller)
  ctx.effect(() => () => controller.close())
  controller.start()
}
