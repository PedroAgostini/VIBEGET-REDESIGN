import type { FastifyInstance } from 'fastify'
import { parse } from '../../lib/validate.js'
import { authOf, metaOf } from '../../plugins/auth.js'
import { redeemSchema } from './schemas.js'
import { redeemCoupon } from './service.js'

export default async function couponRoutes(app: FastifyInstance) {
  // Rate limit forte por IP: impede varredura de códigos (a resposta de erro é sempre a mesma).
  app.post(
    '/me/coupons/redeem',
    { preHandler: app.authenticate, config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } },
    async (req) => {
      const { code } = parse(redeemSchema, req.body)
      return { data: await redeemCoupon(app.ctx, authOf(req).userId, code, metaOf(req)) }
    },
  )
}
