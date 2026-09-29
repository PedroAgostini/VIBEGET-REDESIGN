import type { FastifyInstance } from 'fastify'
import { parse } from '../../lib/validate.js'
import { authOf } from '../../plugins/auth.js'
import { createGetSchema, idempotencyKeySchema, vibeIdParams } from './schemas.js'
import { createGet } from './service.js'

export default async function getRoutes(app: FastifyInstance) {
  app.post(
    '/vibes/:id/gets',
    { preHandler: app.authenticate, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const { id } = parse(vibeIdParams, req.params)
      const key = parse(idempotencyKeySchema, req.headers['idempotency-key'])
      const input = parse(createGetSchema, req.body)
      const result = await createGet(app.ctx, authOf(req).userId, id, input, key)
      return reply.status(result.replayed ? 200 : 201).send({ data: result })
    },
  )
}
