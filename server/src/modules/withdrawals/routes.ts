import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { paginationSchema } from '../../lib/pagination.js'
import { parse } from '../../lib/validate.js'
import { authOf, metaOf } from '../../plugins/auth.js'
import { getCashBalance, listCashLedger } from '../cash/service.js'
import { idempotencyKeySchema } from '../gets/schemas.js'
import * as svc from './service.js'

const createSchema = z
  .object({
    amountCents: z.number().int().positive().max(100_000_000),
    pixKeyType: z.enum(['CPF', 'EMAIL', 'PHONE', 'RANDOM']),
    pixKey: z.string().min(3).max(140),
  })
  .strict()
const idParams = z.object({ id: z.uuid() }).strict()
const rejectSchema = z.object({ reason: z.string().trim().min(5, 'Motivo obrigatório (mín. 5 caracteres).').max(500) }).strict()
const approveSchema = z.object({}).strict()
const adminListQuery = paginationSchema
  .extend({ status: z.enum(['PENDING', 'PAID', 'REJECTED']).optional(), userId: z.uuid().optional() })
  .strict()

export default async function withdrawalRoutes(app: FastifyInstance) {
  const { ctx } = app

  // D6: saldo em R$ + extrato (rota única escolhida: GET /me/cash)
  app.get('/me/cash', { preHandler: app.authenticate }, async (req) => {
    const p = parse(paginationSchema.strict(), req.query)
    const userId = authOf(req).userId
    const [balanceCents, ledger] = await Promise.all([getCashBalance(ctx.db, userId), listCashLedger(ctx.db, userId, p)])
    return { data: { balanceCents }, ledger }
  })

  app.post(
    '/me/withdrawals',
    { preHandler: app.authenticate, config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } },
    async (req, reply) => {
      const key = parse(idempotencyKeySchema, req.headers['idempotency-key'])
      const input = parse(createSchema, req.body)
      const r = await svc.requestWithdrawal(ctx, authOf(req).userId, input, key, metaOf(req))
      const cashBalanceCents = await getCashBalance(ctx.db, authOf(req).userId)
      return reply.status(r.replayed ? 200 : 201).send({ data: { ...r.withdrawal, cashBalanceCents } })
    },
  )
  app.get('/me/withdrawals', { preHandler: app.authenticate }, async (req) =>
    svc.listMyWithdrawals(ctx.db, authOf(req).userId, parse(paginationSchema.strict(), req.query)),
  )

  // Admin: SUPPORT lê (chave mascarada); ADMIN lê (chave completa) e decide
  app.get(
    '/admin/withdrawals',
    { preHandler: [app.authenticate, app.requireRole('SUPPORT', 'ADMIN')] },
    async (req) => svc.listWithdrawalsAdmin(ctx, authOf(req).role, parse(adminListQuery, req.query)),
  )
  const adminOnly = { preHandler: [app.authenticate, app.requireRole('ADMIN')] }
  app.post('/admin/withdrawals/:id/approve', adminOnly, async (req) => {
    const { id } = parse(idParams, req.params)
    parse(approveSchema, req.body ?? {})
    return { data: await svc.decideWithdrawal(ctx, authOf(req), id, { approve: true }, metaOf(req)) }
  })
  app.post('/admin/withdrawals/:id/reject', adminOnly, async (req) => {
    const { id } = parse(idParams, req.params)
    const { reason } = parse(rejectSchema, req.body)
    return { data: await svc.decideWithdrawal(ctx, authOf(req), id, { approve: false, reason }, metaOf(req)) }
  })
}
