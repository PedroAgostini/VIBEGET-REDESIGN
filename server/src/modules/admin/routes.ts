import type { FastifyInstance } from 'fastify'
import { parse } from '../../lib/validate.js'
import { authOf, metaOf } from '../../plugins/auth.js'
import {
  GENERAL_KEYS,
  pickSettings,
  settingsPatchSchema,
  WITHDRAW_KEYS,
  withdrawSettingsPatchSchema,
  GETCOIN_KEYS,
  getcoinSettingsPatchSchema,
  MARKET_KEYS,
  marketSettingsPatchSchema,
} from '../../lib/settings.js'
import {
  createCouponSchema,
  listCouponsQuery,
  listRedemptionsQuery,
  patchCouponSchema,
} from '../coupons/schemas.js'
import * as coupons from '../coupons/service.js'
import {
  createAuctionSchema,
  createProductSchema,
  createVibeSchema,
  idParams,
  listAuditQuery,
  listGetsQuery,
  listProductsQuery,
  listUsersQuery,
  listVibesQuery,
  patchProductSchema,
  patchUserSchema,
  patchVibeSchema,
  walletAdjustmentSchema,
} from './schemas.js'
import * as admin from './service.js'

/**
 * /admin/*: exige login + role. SUPPORT lê; só ADMIN escreve.
 * O hook de leitura roda em todas as rotas; as de escrita somam requireRole('ADMIN').
 */
export default async function adminRoutes(app: FastifyInstance) {
  const { ctx } = app
  app.addHook('preHandler', app.authenticate)
  app.addHook('preHandler', app.requireRole('SUPPORT', 'ADMIN'))
  const adminOnly = { preHandler: app.requireRole('ADMIN') }

  app.get('/admin/dashboard', async () => ({ data: await admin.adminDashboard(ctx) }))

  // usuários
  app.get('/admin/users', async (req) => admin.listUsers(ctx, parse(listUsersQuery, req.query)))
  app.get('/admin/users/:id', async (req) => {
    const { id } = parse(idParams, req.params)
    return { data: await admin.getUser(ctx, id) }
  })
  app.patch('/admin/users/:id', adminOnly, async (req) => {
    const { id } = parse(idParams, req.params)
    const input = parse(patchUserSchema, req.body)
    return { data: await admin.patchUser(ctx, authOf(req), id, input, metaOf(req)) }
  })
  app.post('/admin/users/:id/wallet-adjustments', adminOnly, async (req, reply) => {
    const { id } = parse(idParams, req.params)
    const input = parse(walletAdjustmentSchema, req.body)
    return reply.status(201).send({ data: await admin.adjustWallet(ctx, authOf(req), id, input, metaOf(req)) })
  })
  app.post('/admin/users/:id/cash-adjustments', adminOnly, async (req, reply) => {
    const { id } = parse(idParams, req.params)
    const input = parse(walletAdjustmentSchema, req.body)
    return reply.status(201).send({ data: await admin.adjustCash(ctx, authOf(req), id, input, metaOf(req)) })
  })

  // produtos
  app.get('/admin/products', async (req) => admin.listProducts(ctx, parse(listProductsQuery, req.query)))
  app.post('/admin/products', adminOnly, async (req, reply) => {
    const input = parse(createProductSchema, req.body)
    return reply.status(201).send({ data: await admin.createProduct(ctx, authOf(req), input, metaOf(req)) })
  })
  app.patch('/admin/products/:id', adminOnly, async (req) => {
    const { id } = parse(idParams, req.params)
    const input = parse(patchProductSchema, req.body)
    return { data: await admin.patchProduct(ctx, authOf(req), id, input, metaOf(req)) }
  })

  // Vibes
  app.get('/admin/vibes', async (req) => admin.listVibes(ctx, parse(listVibesQuery, req.query)))
  app.post('/admin/vibes', adminOnly, async (req, reply) => {
    const input = parse(createVibeSchema, req.body)
    return reply.status(201).send({ data: await admin.createVibe(ctx, authOf(req), input, metaOf(req)) })
  })
  app.get('/admin/vibes/:id', async (req) => {
    const { id } = parse(idParams, req.params)
    return { data: await admin.getVibe(ctx, id) }
  })
  app.patch('/admin/vibes/:id', adminOnly, async (req) => {
    const { id } = parse(idParams, req.params)
    const input = parse(patchVibeSchema, req.body)
    return { data: await admin.patchVibe(ctx, authOf(req), id, input, metaOf(req)) }
  })
  app.post('/admin/vibes/:id/close', adminOnly, async (req) => {
    const { id } = parse(idParams, req.params)
    return { data: await admin.closeVibe(ctx, authOf(req), id, metaOf(req)) }
  })

  // Gets/pagamentos (leitura para SUPPORT/ADMIN)
  app.get('/admin/gets', async (req) => admin.listGets(ctx, parse(listGetsQuery, req.query)))

  // D3: configurações (só ADMIN, inclusive leitura)
  app.get('/admin/settings', adminOnly, async () => ({ data: pickSettings(await ctx.settings.get(), GENERAL_KEYS) }))
  app.patch('/admin/settings', adminOnly, async (req) => {
    const patch = parse(settingsPatchSchema, req.body)
    return { data: pickSettings(await ctx.settings.update(patch, authOf(req).userId, metaOf(req).ip), GENERAL_KEYS) }
  })
  // D6: limites de saque (mesmo armazenamento e auditoria; grupo separado)
  app.get('/admin/settings/withdrawals', adminOnly, async () => ({ data: pickSettings(await ctx.settings.get(), WITHDRAW_KEYS) }))
  app.patch('/admin/settings/withdrawals', adminOnly, async (req) => {
    const patch = parse(withdrawSettingsPatchSchema, req.body)
    return { data: pickSettings(await ctx.settings.update(patch, authOf(req).userId, metaOf(req).ip), WITHDRAW_KEYS) }
  })
  // D11/D12: compra avulsa e marketplace (mesmo armazenamento e auditoria; grupos separados)
  app.get('/admin/settings/getcoin', adminOnly, async () => ({ data: pickSettings(await ctx.settings.get(), GETCOIN_KEYS) }))
  app.patch('/admin/settings/getcoin', adminOnly, async (req) => {
    const patch = parse(getcoinSettingsPatchSchema, req.body)
    return { data: pickSettings(await ctx.settings.update(patch, authOf(req).userId, metaOf(req).ip), GETCOIN_KEYS) }
  })
  app.get('/admin/settings/market', adminOnly, async () => ({ data: pickSettings(await ctx.settings.get(), MARKET_KEYS) }))
  app.patch('/admin/settings/market', adminOnly, async (req) => {
    const patch = parse(marketSettingsPatchSchema, req.body)
    return { data: pickSettings(await ctx.settings.update(patch, authOf(req).userId, metaOf(req).ip), MARKET_KEYS) }
  })

  // D4: cupons (SUPPORT lê; ADMIN escreve)
  app.get('/admin/coupons', async (req) => coupons.listCoupons(ctx, parse(listCouponsQuery, req.query)))
  app.post('/admin/coupons', adminOnly, async (req, reply) => {
    const input = parse(createCouponSchema, req.body)
    return reply.status(201).send({ data: await coupons.createCoupon(ctx, authOf(req), input, metaOf(req)) })
  })
  app.patch('/admin/coupons/:id', adminOnly, async (req) => {
    const { id } = parse(idParams, req.params)
    const input = parse(patchCouponSchema, req.body)
    return { data: await coupons.patchCoupon(ctx, authOf(req), id, input, metaOf(req)) }
  })
  app.get('/admin/coupons/:id/redemptions', async (req) => {
    const { id } = parse(idParams, req.params)
    return coupons.listRedemptions(ctx, id, parse(listRedemptionsQuery, req.query))
  })

  // D5: leilão = produto + Vibe numa transação
  app.post('/admin/auctions', adminOnly, async (req, reply) => {
    const input = parse(createAuctionSchema, req.body)
    return reply.status(201).send({ data: await admin.createAuction(ctx, authOf(req), input, metaOf(req)) })
  })

  // audit
  app.get('/admin/audit-logs', async (req) => admin.listAuditLogs(ctx, parse(listAuditQuery, req.query)))
}
