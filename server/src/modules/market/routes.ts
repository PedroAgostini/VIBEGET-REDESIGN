import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { paginationSchema } from '../../lib/pagination.js'
import { parse } from '../../lib/validate.js'
import { authOf, metaOf } from '../../plugins/auth.js'
import { idempotencyKeySchema } from '../gets/schemas.js'
import * as svc from './service.js'

const wholeGetcoins = z
  .number()
  .int()
  .positive()
  .max(100_000_000)
  .refine((v) => v % 100 === 0, 'Use GetCoins inteiros (múltiplos de 100).')

const idParams = z.object({ id: z.uuid() }).strict()
const page = paginationSchema.strict()
const createListingSchema = z
  .object({ getcoinsCents: wholeGetcoins, unitPriceCents: z.number().int().positive().max(100_000) })
  .strict()
const createOrderSchema = z.object({ getcoinsCents: wholeGetcoins, method: z.enum(['PIX', 'CARD', 'BALANCE']) }).strict()
const publicQuery = paginationSchema.extend({ sort: z.enum(['price', 'recent']).default('price') }).strict()
const adminListingsQuery = paginationSchema
  .extend({ status: z.enum(['ACTIVE', 'SOLD_OUT', 'CANCELLED']).optional(), sellerId: z.uuid().optional() })
  .strict()
const adminOrdersQuery = paginationSchema
  .extend({
    status: z.enum(['PENDING_PAYMENT', 'PAID', 'FAILED', 'REFUNDED']).optional(),
    listingId: z.uuid().optional(),
    userId: z.uuid().optional(),
  })
  .strict()

export default async function marketRoutes(app: FastifyInstance) {
  const { ctx } = app
  const auth = { preHandler: app.authenticate }

  // Público
  app.get('/market/listings', async (req) => svc.listPublicListings(ctx, parse(publicQuery, req.query)))

  // Vendedor
  app.post('/me/market/listings', { ...auth, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const input = parse(createListingSchema, req.body)
    return reply.status(201).send({ data: await svc.createListing(ctx, authOf(req).userId, input, metaOf(req)) })
  })
  app.get('/me/market/listings', auth, async (req) => svc.listMyListings(ctx, authOf(req).userId, parse(page, req.query)))
  app.post('/me/market/listings/:id/cancel', auth, async (req) => {
    const { id } = parse(idParams, req.params)
    return { data: await svc.cancelListing(ctx, authOf(req), id, metaOf(req)) }
  })
  app.get('/me/market/sales', auth, async (req) => svc.listMySales(ctx, authOf(req).userId, parse(page, req.query)))

  // Comprador
  app.post(
    '/market/listings/:id/orders',
    { ...auth, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const { id } = parse(idParams, req.params)
      const key = parse(idempotencyKeySchema, req.headers['idempotency-key'])
      const input = parse(createOrderSchema, req.body)
      const r = await svc.createOrder(ctx, authOf(req).userId, id, input, key, metaOf(req))
      return reply.status(r.replayed ? 200 : 201).send({ data: { ...r.order, balances: r.balances } })
    },
  )
  app.get('/me/market/orders', auth, async (req) => svc.listMyOrders(ctx, authOf(req).userId, parse(page, req.query)))
  app.get('/me/market/orders/:id', auth, async (req) => {
    const { id } = parse(idParams, req.params)
    return { data: await svc.getMyOrder(ctx, authOf(req).userId, id) }
  })

  // Admin: SUPPORT lê, ADMIN cancela
  const staff = { preHandler: [app.authenticate, app.requireRole('SUPPORT', 'ADMIN')] }
  app.get('/admin/market/listings', staff, async (req) => svc.adminListListings(ctx, parse(adminListingsQuery, req.query)))
  app.get('/admin/market/orders', staff, async (req) => svc.adminListOrders(ctx, parse(adminOrdersQuery, req.query)))
  app.post('/admin/market/listings/:id/cancel', { preHandler: [app.authenticate, app.requireRole('ADMIN')] }, async (req) => {
    const { id } = parse(idParams, req.params)
    return { data: await svc.cancelListing(ctx, authOf(req), id, metaOf(req), true) }
  })
}
