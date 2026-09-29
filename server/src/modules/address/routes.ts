import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { parse } from '../../lib/validate.js'
import { authOf, metaOf } from '../../plugins/auth.js'
import { addressSchema, cepSchema, lookupCep, putAddress } from './service.js'

export default async function addressRoutes(app: FastifyInstance) {
  app.put('/me/address', { preHandler: app.authenticate }, async (req) => {
    const input = parse(addressSchema, req.body)
    return { user: await putAddress(app.ctx, authOf(req).userId, input, metaOf(req)) }
  })

  // Público com rate limit (proxy ViaCEP -> BrasilAPI, cache 24 h)
  app.get('/cep/:cep', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    const { cep } = parse(z.object({ cep: cepSchema }).strict(), req.params)
    return { data: await lookupCep(app.ctx.fetch, cep) }
  })
}
