import { MAX_FRAME } from './protocol.js'
import { safeError } from './util.js'

export const MANAGEMENT_ENDPOINT = 'agent-hub'
export function installManagement(ctx, controller) {
  if (!ctx.connection?.fetch?.register) throw new Error('unsupported-harness-management')
  const dispose = ctx.connection.fetch.register({
    path: '/api/' + MANAGEMENT_ENDPOINT, methods: ['POST'], requestBody: 'buffered',
    async fetch(request) {
      // Admission, browser authentication, and Host/Origin validation belong to Harness.
      // This route is on its private authenticated carrier, never on the public Hub listener.
      if (request.method !== 'POST') return new Response('method not allowed', { status: 405 })
      if (!request.headers.get('content-type')?.startsWith('application/json')) return new Response('JSON required', { status: 415 })
      const text = await request.text()
      if (Buffer.byteLength(text) > MAX_FRAME) return new Response('too large', { status: 413 })
      let message
      try { message = JSON.parse(text) } catch { return new Response('invalid JSON', { status: 400 }) }
      const reply = (result) => Response.json({ type: 'server-response', rpcId: message.rpcId || 'invalid-request', result })
      if (message.type !== 'client-request' || message.method !== MANAGEMENT_ENDPOINT || typeof message.rpcId !== 'string' || typeof message.payload?.method !== 'string' || !message.payload.payload || typeof message.payload.payload !== 'object') return reply({ ok: false, error: { code: 'bad-request', message: 'bad-request', details: {} } })
      try { return reply({ ok: true, value: await controller.call(message.payload.method, message.payload.payload) }) }
      catch (error) { const code = safeError(error); return reply({ ok: false, error: { code, message: code, details: {} } }) }
    },
  })
  ctx.effect(() => dispose)
}
