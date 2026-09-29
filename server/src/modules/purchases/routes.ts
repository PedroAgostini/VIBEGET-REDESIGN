import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { paginationSchema } from '../../lib/pagination.js'
import { parse } from '../../lib/validate.js'
import { authOf, metaOf } from '../../plugins/auth.js'
import { idempotencyKeySchema } from '../gets/schemas.js'
import { createPackageSchema, createPurchaseSchema, patchPackageSchema } from './schemas.js'
import * as svc from './service.js'

const idParams = z.object({ id: z.uuid() }).strict()

export default async function purchaseRoutes(app: FastifyInstance) {
  const { ctx } = app

  // Público: pacotes ativos
  app.get('/getcoin-packages', async () => ({
    data: await svc.listActivePackages(ctx.db),
    // D11: compra avulsa
    custom: await svc.customPurchaseConfig(ctx),
  }))

  // Usuário
  app.post(
    '/me/getcoin-purchases',
    { preHandler: app.authenticate, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const key = parse(idempotencyKeySchema, req.headers['idempotency-key'])
      const input = parse(createPurchaseSchema, req.body)
      const r = await svc.createPurchase(ctx, authOf(req).userId, input, key, metaOf(req))
      return reply.status(r.replayed ? 200 : 201).send({ data: { ...r.purchase, balances: r.balances } })
    },
  )
  app.get('/me/getcoin-purchases', { preHandler: app.authenticate }, async (req) =>
    svc.listMyPurchases(ctx, authOf(req).userId, parse(paginationSchema.strict(), req.query)),
  )
  app.get('/me/getcoin-purchases/:id', { preHandler: app.authenticate }, async (req) => {
    const { id } = parse(idParams, req.params)
    return { data: await svc.getMyPurchase(ctx, authOf(req).userId, id) }
  })

  // Admin (só ADMIN, inclusive leitura)
  const adminOnly = { preHandler: [app.authenticate, app.requireRole('ADMIN')] }
  app.get('/admin/getcoin-packages', adminOnly, async () => ({ data: await svc.listPackagesAdmin(ctx) }))
  app.post('/admin/getcoin-packages', adminOnly, async (req, reply) => {
    const input = parse(createPackageSchema, req.body)
    return reply.status(201).send({ data: await svc.createPackage(ctx, authOf(req), input, metaOf(req)) })
  })
  app.patch('/admin/getcoin-packages/:id', adminOnly, async (req) => {
    const { id } = parse(idParams, req.params)
    const input = parse(patchPackageSchema, req.body)
    return { data: await svc.patchPackage(ctx, authOf(req), id, input, metaOf(req)) }
  })
  app.delete('/admin/getcoin-packages/:id', adminOnly, async (req, reply) => {
    const { id } = parse(idParams, req.params)
    await svc.deletePackage(ctx, authOf(req), id, metaOf(req))
    return reply.status(204).send()
  })
}
