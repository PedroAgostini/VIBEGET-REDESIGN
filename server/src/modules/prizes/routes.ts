import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { paginationSchema } from '../../lib/pagination.js'
import { parse } from '../../lib/validate.js'
import { authOf, metaOf } from '../../plugins/auth.js'
import * as svc from './service.js'

const idParams = z.object({ id: z.uuid() }).strict()
const adminListQuery = paginationSchema.extend({ status: z.enum(svc.PRIZE_STATUSES).optional() }).strict()

export default async function prizeRoutes(app: FastifyInstance) {
  const { ctx } = app
  const auth = { preHandler: app.authenticate }

  // D13: prêmios do próprio usuário (nunca de outro: filtro por user_id e 404 no id alheio)
  app.get('/me/prizes', auth, async (req) => ({ data: await svc.listMyPrizes(ctx.db, authOf(req).userId) }))

  app.put('/me/prizes/:id/address', { ...auth, config: { rateLimit: { max: 20, timeWindow: '15 minutes' } } }, async (req) => {
    const { id } = parse(idParams, req.params)
    const input = parse(svc.confirmAddressSchema, req.body)
    return { data: await svc.confirmAddress(ctx, authOf(req).userId, id, input, metaOf(req)) }
  })

  const staff = { preHandler: [app.authenticate, app.requireRole('SUPPORT', 'ADMIN')] }
  const adminOnly = { preHandler: [app.authenticate, app.requireRole('ADMIN')] }

  app.get('/admin/prizes', staff, async (req) => svc.listPrizesAdmin(ctx.db, parse(adminListQuery, req.query)))

  app.patch('/admin/prizes/:id', adminOnly, async (req) => {
    const { id } = parse(idParams, req.params)
    const input = parse(svc.shipSchema, req.body)
    return { data: await svc.updatePrizeAdmin(ctx, authOf(req).userId, id, input, metaOf(req)) }
  })
}
