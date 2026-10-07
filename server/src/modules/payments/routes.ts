import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { hmacSha256Hex, safeEqual } from '../../lib/crypto.js'
import { AppError, notFound } from '../../lib/errors.js'
import { parse } from '../../lib/validate.js'
import { authOf } from '../../plugins/auth.js'
import { applyPaymentOutcome, effectivePaidAt, findPaymentByExternalId, paymentOwner } from './service.js'

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: string
  }
}

const webhookSchema = z
  .object({
    externalId: z.string().min(1).max(128),
    status: z.enum(['PAID', 'FAILED']),
    /** QA-21: horário do pagamento no provedor (ISO 8601). Opcional; ver effectivePaidAt. */
    paidAt: z.iso.datetime({ offset: true }).optional(),
  })
  .strict()

const simulateSchema = z.object({ status: z.enum(['PAID', 'FAILED']) }).strict()
const idParams = z.object({ id: z.uuid() }).strict()

export default async function paymentRoutes(app: FastifyInstance) {
  const { ctx } = app

  // Webhook num contexto encapsulado: precisa do corpo cru para validar a assinatura HMAC.
  await app.register(async (hook) => {
    hook.removeContentTypeParser('application/json')
    hook.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
      req.rawBody = body as string
      try {
        done(null, JSON.parse(body as string))
      } catch {
        done(new AppError(400, 'INVALID_JSON', 'JSON inválido.'), undefined)
      }
    })

    hook.post('/payments/webhook', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req, reply) => {
      const header = req.headers['x-signature']
      const signature = typeof header === 'string' ? header.replace(/^sha256=/i, '').toLowerCase() : ''
      const expected = hmacSha256Hex(ctx.env.PAYMENT_WEBHOOK_SECRET, req.rawBody ?? '')
      if (!signature || !safeEqual(signature, expected)) {
        throw new AppError(401, 'INVALID_SIGNATURE', 'Assinatura inválida.')
      }
      const body = parse(webhookSchema, req.body)
      const payment = await findPaymentByExternalId(ctx.db, body.externalId)
      if (!payment) throw notFound('Pagamento não encontrado.')
      const paidAt = effectivePaidAt(body.paidAt ? new Date(body.paidAt) : undefined, new Date(req.receivedAt))
      const { changed } = await applyPaymentOutcome(ctx, payment.id, body.status, 'webhook', paidAt)
      return reply.status(200).send({ received: true, changed })
    })
  })

  // Simulação de pagamento: só com NODE_ENV=development|test explícito (nunca em produção ou sem NODE_ENV).
  if (ctx.env.allowPaymentSimulation) {
    app.post('/payments/:id/simulate', { preHandler: app.authenticate }, async (req) => {
      const { id } = parse(idParams, req.params)
      const { status } = parse(simulateSchema, req.body)
      const me = authOf(req)
      const owner = await paymentOwner(ctx.db, id)
      // Sem vazar existência: pagamento de outro usuário responde 404 (exceto ADMIN).
      if (!owner || (owner !== me.userId && me.role !== 'ADMIN')) throw notFound('Pagamento não encontrado.')
      const { payment, changed } = await applyPaymentOutcome(ctx, id, status, 'simulate')
      return {
        data: { id: payment.id, status: payment.status, paidAt: payment.paidAt },
        changed,
      }
    })
  }
}
