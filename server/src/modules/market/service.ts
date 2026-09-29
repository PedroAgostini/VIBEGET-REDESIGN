import { and, asc, count, desc, eq, gt, gte, inArray, sql, sum, type SQL } from 'drizzle-orm'
import type { AppContext, AuthInfo, RequestMeta } from '../../context.js'
import type { DbOrTx } from '../../db/client.js'
import { marketListings, marketOrders, payments, users, type MarketListing, type MarketOrder } from '../../db/schema.js'
import { audit } from '../../lib/audit.js'
import { randomToken } from '../../lib/crypto.js'
import { AppError, conflict, forbidden, isUniqueViolation, notFound } from '../../lib/errors.js'
import { toNumber } from '../../lib/money.js'
import { offsetOf, paginated, type Pagination } from '../../lib/pagination.js'
import { publicName } from '../../lib/presenters.js'
import { getCashBalance } from '../cash/service.js'
import { mockProvider } from '../payments/service.js'
import { applyWalletMovement, getBalance } from '../wallet/service.js'
import { markSoldOutIfDone, marketFee, orderTotal, settlePaidOrder } from './core.js'

const unavailable = () => new AppError(409, 'LISTING_UNAVAILABLE', 'Este anúncio não está disponível.')

/** Vendedor e comprador: conta ativa e e-mail confirmado (D12). */
async function assertTrader(db: DbOrTx, userId: string, role: 'vender' | 'comprar') {
  const [u] = await db.select({ status: users.status, verified: users.emailVerifiedAt }).from(users).where(eq(users.id, userId))
  if (!u || u.status !== 'ACTIVE') throw forbidden('Conta inativa.', 'ACCOUNT_INACTIVE')
  if (!u.verified) throw forbidden(`Confirme seu e-mail antes de ${role} GetCoin.`, 'EMAIL_NOT_VERIFIED')
}

/** Config pública do marketplace (tela de vender). Sem dados de usuário. */
export async function marketConfig(ctx: AppContext) {
  const cfg = await ctx.settings.get()
  return {
    enabled: cfg.marketEnabled,
    feePercent: cfg.marketFeePercent,
    minUnitPriceCents: cfg.marketMinUnitPriceCents,
    maxUnitPriceCents: cfg.marketMaxUnitPriceCents,
    minListingCents: cfg.marketMinListingCents,
  }
}

// ---------- anúncios ----------

export async function listPublicListings(ctx: AppContext, q: Pagination & { sort: 'price' | 'recent' }) {
  // QA-24: só anúncios de vendedor com conta ACTIVE aparecem na vitrine
  const where = and(eq(marketListings.status, 'ACTIVE'), gt(marketListings.remainingCents, 0), eq(users.status, 'ACTIVE'))
  const order =
    q.sort === 'price'
      ? [asc(marketListings.unitPriceCents), asc(marketListings.createdAt), asc(marketListings.id)]
      : [desc(marketListings.createdAt), desc(marketListings.id)]
  const [rows, [{ total } = { total: 0 }]] = await Promise.all([
    ctx.db
      .select({ l: marketListings, sellerName: users.name })
      .from(marketListings)
      .innerJoin(users, eq(users.id, marketListings.sellerId))
      .where(where)
      .orderBy(...order)
      .limit(q.pageSize)
      .offset(offsetOf(q)),
    ctx.db.select({ total: count() }).from(marketListings).innerJoin(users, eq(users.id, marketListings.sellerId)).where(where),
  ])
  return {
    ...paginated(
      rows.map((r) => ({
        id: r.l.id,
        seller: publicName(r.sellerName),
        unitPriceCents: r.l.unitPriceCents,
        remainingCents: r.l.remainingCents,
        totalCents: r.l.totalCents,
        createdAt: r.l.createdAt,
      })),
      total,
      q,
    ),
    config: await marketConfig(ctx),
  }
}

/** Reservado (pedidos pendentes) e vendido (pedidos pagos) por anúncio. */
async function listingTotals(db: DbOrTx, listingIds: string[]) {
  const map = new Map<string, { reservedCents: number; soldCents: number }>()
  for (const id of listingIds) map.set(id, { reservedCents: 0, soldCents: 0 })
  if (listingIds.length === 0) return map
  const rows = await db
    .select({ listingId: marketOrders.listingId, status: marketOrders.status, s: sum(marketOrders.getcoinsCents) })
    .from(marketOrders)
    .where(and(inArray(marketOrders.listingId, listingIds), inArray(marketOrders.status, ['PENDING_PAYMENT', 'PAID'])))
    .groupBy(marketOrders.listingId, marketOrders.status)
  for (const r of rows) {
    const m = map.get(r.listingId)!
    if (r.status === 'PENDING_PAYMENT') m.reservedCents = toNumber(r.s)
    else m.soldCents = toNumber(r.s)
  }
  return map
}

function toMyListing(l: MarketListing, t: { reservedCents: number; soldCents: number }) {
  return {
    id: l.id,
    unitPriceCents: l.unitPriceCents,
    totalCents: l.totalCents,
    remainingCents: l.remainingCents,
    reservedCents: t.reservedCents,
    soldCents: t.soldCents,
    status: l.status,
    createdAt: l.createdAt,
  }
}

export async function listMyListings(ctx: AppContext, sellerId: string, p: Pagination) {
  const where = eq(marketListings.sellerId, sellerId)
  const [rows, [{ total } = { total: 0 }]] = await Promise.all([
    ctx.db.select().from(marketListings).where(where).orderBy(desc(marketListings.createdAt), desc(marketListings.id)).limit(p.pageSize).offset(offsetOf(p)),
    ctx.db.select({ total: count() }).from(marketListings).where(where),
  ])
  const totals = await listingTotals(
    ctx.db,
    rows.map((r) => r.id),
  )
  return paginated(
    rows.map((r) => toMyListing(r, totals.get(r.id)!)),
    total,
    p,
  )
}

/** Anunciar: GetCoins saem da carteira para custódia (MARKET_ESCROW), na mesma transação. */
export async function createListing(
  ctx: AppContext,
  sellerId: string,
  input: { getcoinsCents: number; unitPriceCents: number },
  meta: RequestMeta,
) {
  const cfg = await ctx.settings.get()
  if (!cfg.marketEnabled) throw new AppError(422, 'MARKET_DISABLED', 'O marketplace está desativado no momento.')
  if (input.getcoinsCents < cfg.marketMinListingCents) {
    throw new AppError(422, 'LISTING_BELOW_MINIMUM', 'Quantidade abaixo do mínimo para anunciar.')
  }
  if (input.unitPriceCents < cfg.marketMinUnitPriceCents || input.unitPriceCents > cfg.marketMaxUnitPriceCents) {
    throw new AppError(422, 'UNIT_PRICE_OUT_OF_RANGE', 'Preço por GetCoin fora da faixa permitida.')
  }
  await assertTrader(ctx.db, sellerId, 'vender')
  const listing = await ctx.db.transaction(async (tx) => {
    const [l] = await tx
      .insert(marketListings)
      .values({ sellerId, unitPriceCents: input.unitPriceCents, totalCents: input.getcoinsCents, remainingCents: input.getcoinsCents })
      .returning()
    await applyWalletMovement(tx, {
      userId: sellerId,
      amountCents: -input.getcoinsCents,
      type: 'MARKET_ESCROW',
      referenceType: 'market_listing',
      referenceId: l!.id,
      reason: 'GetCoin anunciado no marketplace (custódia)',
    })
    await audit(tx, {
      actorId: sellerId,
      action: 'MARKET_LISTING_CREATED',
      entity: 'market_listing',
      entityId: l!.id,
      metadata: { getcoinsCents: input.getcoinsCents, unitPriceCents: input.unitPriceCents },
      ip: meta.ip,
    })
    return l!
  })
  return toMyListing(listing, { reservedCents: 0, soldCents: 0 })
}

/**
 * Cancelar anúncio (dono ou ADMIN): devolve o restante (MARKET_ESCROW_RETURN).
 * Pedidos pendentes continuam; se falharem, a quantidade volta direto para o vendedor.
 */
export async function cancelListing(ctx: AppContext, actor: AuthInfo, listingId: string, meta: RequestMeta, asAdmin = false) {
  const result = await ctx.db.transaction(async (tx) => {
    const [l] = await tx.select().from(marketListings).where(eq(marketListings.id, listingId)).for('update')
    if (!l || (!asAdmin && l.sellerId !== actor.userId)) throw notFound('Anúncio não encontrado.')
    if (l.status !== 'ACTIVE') throw conflict('Este anúncio já foi encerrado.', 'LISTING_NOT_ACTIVE')
    const returned = l.remainingCents
    const [upd] = await tx
      .update(marketListings)
      .set({ status: 'CANCELLED', remainingCents: 0 })
      .where(eq(marketListings.id, listingId))
      .returning()
    if (returned > 0) {
      await applyWalletMovement(tx, {
        userId: l.sellerId,
        amountCents: returned,
        type: 'MARKET_ESCROW_RETURN',
        referenceType: 'market_listing',
        referenceId: l.id,
        reason: asAdmin ? 'Anúncio cancelado pelo administrador' : 'Anúncio cancelado',
      })
    }
    await audit(tx, {
      actorId: actor.userId,
      action: asAdmin ? 'MARKET_LISTING_CANCELLED_BY_ADMIN' : 'MARKET_LISTING_CANCELLED',
      entity: 'market_listing',
      entityId: l.id,
      metadata: { returnedCents: returned, sellerId: l.sellerId },
      ip: meta.ip,
    })
    return { listing: upd!, returnedCents: returned }
  })
  const totals = await listingTotals(ctx.db, [listingId])
  return { ...toMyListing(result.listing, totals.get(listingId)!), returnedCents: result.returnedCents }
}

// ---------- pedidos ----------

export const COOLDOWN_FAILURES = 3
export const COOLDOWN_HOURS = 24

/**
 * QA-23 — limites contra reserva sem custo:
 * - no máximo `marketMaxPendingOrders` pedidos PENDING_PAYMENT por comprador, e 1 por anúncio;
 * - esfriamento: 3 pedidos FAILED (expirados/recusados) nas últimas 24 h bloqueiam novos pedidos
 *   até a 3ª falha mais recente sair da janela de 24 h.
 */
async function assertBuyerLimits(tx: DbOrTx, buyerId: string, listingId: string, maxPending: number) {
  const since = new Date(Date.now() - COOLDOWN_HOURS * 60 * 60 * 1000)
  const [[pend], [same], [failed]] = await Promise.all([
    tx.select({ n: count() }).from(marketOrders).where(and(eq(marketOrders.buyerId, buyerId), eq(marketOrders.status, 'PENDING_PAYMENT'))),
    tx
      .select({ n: count() })
      .from(marketOrders)
      .where(and(eq(marketOrders.buyerId, buyerId), eq(marketOrders.listingId, listingId), eq(marketOrders.status, 'PENDING_PAYMENT'))),
    tx
      .select({ n: count() })
      .from(marketOrders)
      .where(and(eq(marketOrders.buyerId, buyerId), eq(marketOrders.status, 'FAILED'), gte(marketOrders.updatedAt, since))),
  ])
  if ((failed?.n ?? 0) >= COOLDOWN_FAILURES) {
    throw new AppError(429, 'MARKET_COOLDOWN', 'Muitos pedidos não pagos nas últimas 24 horas. Tente novamente mais tarde.')
  }
  if ((same?.n ?? 0) >= 1 || (pend?.n ?? 0) >= maxPending) {
    throw new AppError(429, 'MARKET_TOO_MANY_PENDING', 'Você já tem pedidos aguardando pagamento. Pague ou aguarde expirar.')
  }
}

type PayView = { id: string; status: string; pixCopyPaste: string | null; expiresAt: Date; paidAt: Date | null } | null

function toOrderView(o: MarketOrder, pay: PayView) {
  return {
    id: o.id,
    listingId: o.listingId,
    getcoinsCents: o.getcoinsCents,
    unitPriceCents: o.unitPriceCents,
    totalPriceCents: o.totalPriceCents,
    method: o.method,
    status: o.status,
    payment: pay,
    createdAt: o.createdAt,
  }
}

const payCols = {
  id: payments.id,
  status: payments.status,
  pixCopyPaste: payments.pixCopyPaste,
  expiresAt: payments.expiresAt,
  paidAt: payments.paidAt,
}

async function loadOrder(db: DbOrTx, buyerId: string, orderId: string) {
  const [r] = await db
    .select({ o: marketOrders, pay: payCols })
    .from(marketOrders)
    .leftJoin(payments, eq(payments.orderId, marketOrders.id))
    .where(and(eq(marketOrders.id, orderId), eq(marketOrders.buyerId, buyerId)))
  return r ? toOrderView(r.o, r.pay) : null
}

export async function getMyOrder(ctx: AppContext, buyerId: string, orderId: string) {
  const v = await loadOrder(ctx.db, buyerId, orderId)
  if (!v) throw notFound('Pedido não encontrado.')
  return v
}

export async function listMyOrders(ctx: AppContext, buyerId: string, p: Pagination) {
  const where = eq(marketOrders.buyerId, buyerId)
  const [rows, [{ total } = { total: 0 }]] = await Promise.all([
    ctx.db
      .select({ o: marketOrders, pay: payCols })
      .from(marketOrders)
      .leftJoin(payments, eq(payments.orderId, marketOrders.id))
      .where(where)
      .orderBy(desc(marketOrders.createdAt), desc(marketOrders.id))
      .limit(p.pageSize)
      .offset(offsetOf(p)),
    ctx.db.select({ total: count() }).from(marketOrders).where(where),
  ])
  return paginated(
    rows.map((r) => toOrderView(r.o, r.pay)),
    total,
    p,
  )
}

/** Vendas nos meus anúncios (sem dados do comprador). */
export async function listMySales(ctx: AppContext, sellerId: string, p: Pagination) {
  const where = eq(marketOrders.sellerId, sellerId)
  const [rows, [{ total } = { total: 0 }]] = await Promise.all([
    ctx.db.select().from(marketOrders).where(where).orderBy(desc(marketOrders.createdAt), desc(marketOrders.id)).limit(p.pageSize).offset(offsetOf(p)),
    ctx.db.select({ total: count() }).from(marketOrders).where(where),
  ])
  return paginated(
    rows.map((o) => ({
      id: o.id,
      listingId: o.listingId,
      getcoinsCents: o.getcoinsCents,
      unitPriceCents: o.unitPriceCents,
      totalPriceCents: o.totalPriceCents,
      feeCents: o.feeCents,
      sellerNetCents: o.sellerNetCents,
      status: o.status,
      createdAt: o.createdAt,
    })),
    total,
    p,
  )
}

/**
 * Pedido de compra (D12). Idempotente por (comprador, Idempotency-Key).
 * Trava o anúncio (FOR UPDATE) e tira a quantidade de remaining na mesma transação: nunca vende além do disponível.
 * BALANCE: pago na hora (GetCoin para o comprador, R$ para o vendedor menos a taxa).
 */
export async function createOrder(
  ctx: AppContext,
  buyerId: string,
  listingId: string,
  input: { getcoinsCents: number; method: 'PIX' | 'CARD' | 'BALANCE' },
  idempotencyKey: string,
  meta: RequestMeta,
) {
  const { db, env } = ctx
  const replay = async () => {
    const [o] = await db
      .select()
      .from(marketOrders)
      .where(and(eq(marketOrders.buyerId, buyerId), eq(marketOrders.idempotencyKey, idempotencyKey)))
    if (!o) return null
    if (o.listingId !== listingId || o.getcoinsCents !== input.getcoinsCents || o.method !== input.method) {
      throw conflict('Idempotency-Key já usada com outros dados.', 'IDEMPOTENCY_KEY_REUSED')
    }
    return { order: (await loadOrder(db, buyerId, o.id))!, replayed: true }
  }
  const prior = await replay()
  if (prior) return withBalances(ctx, buyerId, prior)

  const cfg = await ctx.settings.get()
  if (!cfg.marketEnabled) throw new AppError(422, 'MARKET_DISABLED', 'O marketplace está desativado no momento.')
  await assertTrader(db, buyerId, 'comprar')

  try {
    const orderId = await db.transaction(async (tx) => {
      // QA-23: serializa os pedidos do mesmo comprador (lock consultivo, sempre antes do anúncio) e aplica os limites
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'vibeget.market.buyer:' + buyerId}))`)
      await assertBuyerLimits(tx, buyerId, listingId, cfg.marketMaxPendingOrders)
      const [l] = await tx.select().from(marketListings).where(eq(marketListings.id, listingId)).for('update')
      if (!l) throw notFound('Anúncio não encontrado.')
      if (l.sellerId === buyerId) throw forbidden('Você não pode comprar do próprio anúncio.', 'OWN_LISTING')
      if (l.status !== 'ACTIVE') throw unavailable()
      const [seller] = await tx.select({ status: users.status, verified: users.emailVerifiedAt }).from(users).where(eq(users.id, l.sellerId))
      if (!seller || seller.status !== 'ACTIVE' || !seller.verified) throw unavailable()
      if (input.getcoinsCents > l.remainingCents) {
        throw new AppError(409, 'LISTING_INSUFFICIENT', 'Quantidade maior que a disponível neste anúncio.')
      }

      const totalPriceCents = orderTotal(input.getcoinsCents, l.unitPriceCents)
      const { feeCents, sellerNetCents } = marketFee(totalPriceCents, cfg.marketFeePercent)
      await tx
        .update(marketListings)
        .set({ remainingCents: l.remainingCents - input.getcoinsCents })
        .where(eq(marketListings.id, l.id))
      const paid = input.method === 'BALANCE'
      const [order] = await tx
        .insert(marketOrders)
        .values({
          listingId: l.id,
          buyerId,
          sellerId: l.sellerId,
          getcoinsCents: input.getcoinsCents,
          unitPriceCents: l.unitPriceCents,
          totalPriceCents,
          feeCents,
          sellerNetCents,
          method: input.method,
          status: paid ? 'PAID' : 'PENDING_PAYMENT',
          idempotencyKey,
        })
        .returning()
      const now = new Date()
      if (paid) {
        await tx.insert(payments).values({
          orderId: order!.id,
          provider: 'INTERNAL',
          method: 'BALANCE',
          status: 'PAID',
          amountCents: totalPriceCents,
          externalId: `bal_${randomToken(16)}`,
          expiresAt: now,
          paidAt: now,
        })
        await settlePaidOrder(tx, order!, { buyerPaysWithBalance: true })
        await markSoldOutIfDone(tx, l.id)
      } else {
        const charge = mockProvider.createCharge({ amountCents: totalPriceCents, method: input.method as 'PIX' | 'CARD' })
        await tx.insert(payments).values({
          orderId: order!.id,
          provider: 'MOCK',
          method: input.method,
          status: 'PENDING',
          amountCents: totalPriceCents,
          externalId: charge.externalId,
          pixCopyPaste: charge.pixCopyPaste,
          // QA-23: prazo próprio (menor) para pedidos do marketplace
          expiresAt: new Date(now.getTime() + cfg.marketOrderTtlMinutes * 60_000),
        })
      }
      await audit(tx, {
        actorId: buyerId,
        action: 'MARKET_ORDER_CREATED',
        entity: 'market_order',
        entityId: order!.id,
        metadata: { listingId: l.id, getcoinsCents: input.getcoinsCents, totalPriceCents, feeCents, method: input.method },
        ip: meta.ip,
      })
      return order!.id
    })
    return withBalances(ctx, buyerId, { order: (await loadOrder(db, buyerId, orderId))!, replayed: false })
  } catch (err) {
    if (isUniqueViolation(err, 'market_orders_buyer_idempotency_uq')) {
      const again = await replay()
      if (again) return withBalances(ctx, buyerId, again)
    }
    throw err
  }
}

async function withBalances<T extends object>(ctx: AppContext, userId: string, r: T) {
  const [cashBalanceCents, getcoinBalanceCents] = await Promise.all([getCashBalance(ctx.db, userId), getBalance(ctx.db, userId)])
  return { ...r, balances: { cashBalanceCents, getcoinBalanceCents } }
}

// ---------- admin ----------

export async function adminListListings(
  ctx: AppContext,
  q: Pagination & { status?: 'ACTIVE' | 'SOLD_OUT' | 'CANCELLED' | undefined; sellerId?: string | undefined },
) {
  const conds: SQL[] = []
  if (q.status) conds.push(eq(marketListings.status, q.status))
  if (q.sellerId) conds.push(eq(marketListings.sellerId, q.sellerId))
  const where = conds.length ? and(...conds) : undefined
  const [rows, [{ total } = { total: 0 }]] = await Promise.all([
    ctx.db
      .select({ l: marketListings, sellerName: users.name, sellerEmail: users.email })
      .from(marketListings)
      .innerJoin(users, eq(users.id, marketListings.sellerId))
      .where(where)
      .orderBy(desc(marketListings.createdAt), desc(marketListings.id))
      .limit(q.pageSize)
      .offset(offsetOf(q)),
    ctx.db.select({ total: count() }).from(marketListings).where(where),
  ])
  const totals = await listingTotals(
    ctx.db,
    rows.map((r) => r.l.id),
  )
  return paginated(
    rows.map((r) => ({ ...toMyListing(r.l, totals.get(r.l.id)!), sellerId: r.l.sellerId, sellerName: r.sellerName, sellerEmail: r.sellerEmail })),
    total,
    q,
  )
}

export async function adminListOrders(
  ctx: AppContext,
  q: Pagination & {
    status?: 'PENDING_PAYMENT' | 'PAID' | 'FAILED' | 'REFUNDED' | undefined
    listingId?: string | undefined
    userId?: string | undefined
  },
) {
  const conds: SQL[] = []
  if (q.status) conds.push(eq(marketOrders.status, q.status))
  if (q.listingId) conds.push(eq(marketOrders.listingId, q.listingId))
  if (q.userId) conds.push(sql`(${marketOrders.buyerId} = ${q.userId} OR ${marketOrders.sellerId} = ${q.userId})`)
  const where = conds.length ? and(...conds) : undefined
  const [rows, [{ total } = { total: 0 }], [fees]] = await Promise.all([
    ctx.db
      .select({ o: marketOrders, pay: { id: payments.id, status: payments.status, method: payments.method, paidAt: payments.paidAt } })
      .from(marketOrders)
      .leftJoin(payments, eq(payments.orderId, marketOrders.id))
      .where(where)
      .orderBy(desc(marketOrders.createdAt), desc(marketOrders.id))
      .limit(q.pageSize)
      .offset(offsetOf(q)),
    ctx.db.select({ total: count() }).from(marketOrders).where(where),
    ctx.db.select({ s: sum(marketOrders.feeCents) }).from(marketOrders).where(eq(marketOrders.status, 'PAID')),
  ])
  return {
    ...paginated(
      rows.map((r) => ({ ...r.o, idempotencyKey: undefined, payment: r.pay })),
      total,
      q,
    ),
    summary: { feeRevenueCents: toNumber(fees?.s) },
  }
}

/** Painel admin: receita de taxas = Σ fee_cents dos pedidos pagos. */
export async function marketFeeRevenue(db: DbOrTx) {
  const [r] = await db
    .select({ s: sum(marketOrders.feeCents), n: count() })
    .from(marketOrders)
    .where(eq(marketOrders.status, 'PAID'))
  return { feeRevenueCents: toNumber(r?.s), paidOrders: r?.n ?? 0 }
}
