import { and, count, desc, eq, gte, ilike, isNull, lte, ne, or, sql, sum, type SQL } from 'drizzle-orm'
import type { z } from 'zod'
import type { AppContext, AuthInfo, RequestMeta } from '../../context.js'
import type { Tx } from '../../db/client.js'
import { auditLogs, getcoinLedger, gets, payments, prizeDeliveries, products, users, vibes, withdrawals } from '../../db/schema.js'
import { audit } from '../../lib/audit.js'
import { normalizeCpf } from '../../lib/cpf.js'
import { AppError, conflict, forbidden, isUniqueViolation, notFound } from '../../lib/errors.js'
import { toNumber } from '../../lib/money.js'
import { escapeLike, offsetOf, paginated } from '../../lib/pagination.js'
import { toAdminUser } from '../../lib/presenters.js'
import { revokeAllSessions } from '../auth/service.js'
import { cancelVibe, settleVibe } from '../vibes/settlement.js'
import { vibeDeadlines } from '../vibes/deadlines.js'
import { marketFeeRevenue } from '../market/service.js'
import { cancelSellerListings } from '../market/core.js'
import { vibeStats } from '../vibes/service.js'
import { applyWalletMovement, getBalance } from '../wallet/service.js'
import { applyCashMovement, getCashBalance } from '../cash/service.js'
import type {
  createAuctionSchema,
  createProductSchema,
  createVibeSchema,
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
import { VIBE_MAX_DURATION_MS } from './schemas.js'

type In<T extends z.ZodType> = z.output<T>

// ---------- dashboard ----------

export async function adminDashboard(ctx: AppContext) {
  const { db } = ctx
  const now = Date.now()
  const d7 = new Date(now - 7 * 24 * 60 * 60 * 1000)
  const d1 = new Date(now - 24 * 60 * 60 * 1000)
  const notDeleted = ne(users.status, 'DELETED')

  const [[usersTotal], [usersNew7d], byLevel, byRole, vibesByStatus, [revenue], ledgerByType, [gets24h]] =
    await Promise.all([
      db.select({ n: count() }).from(users).where(notDeleted),
      db.select({ n: count() }).from(users).where(and(notDeleted, gte(users.createdAt, d7))),
      db.select({ level: users.level, n: count() }).from(users).where(notDeleted).groupBy(users.level),
      db.select({ role: users.role, n: count() }).from(users).where(notDeleted).groupBy(users.role),
      db.select({ status: vibes.status, n: count() }).from(vibes).groupBy(vibes.status),
      db.select({ total: sum(payments.amountCents) }).from(payments).where(and(eq(payments.status, 'PAID'), isNull(payments.orderId))),
      db
        .select({ type: getcoinLedger.type, total: sum(getcoinLedger.amountCents) })
        .from(getcoinLedger)
        .groupBy(getcoinLedger.type),
      db.select({ n: count() }).from(gets).where(gte(gets.createdAt, d1)),
    ])

  const ledger = Object.fromEntries(ledgerByType.map((r) => [r.type, toNumber(r.total)]))
  const issued = Object.entries(ledger)
    .filter(([, v]) => v > 0)
    .reduce((a, [, v]) => a + v, 0)
  const spent = Math.abs(
    Object.entries(ledger)
      .filter(([, v]) => v < 0)
      .reduce((a, [, v]) => a + v, 0),
  )

  return {
    users: {
      total: usersTotal?.n ?? 0,
      new7d: usersNew7d?.n ?? 0,
      byLevel: Object.fromEntries(byLevel.map((r) => [r.level, r.n])),
      byRole: Object.fromEntries(byRole.map((r) => [r.role, r.n])),
    },
    vibes: { byStatus: Object.fromEntries(vibesByStatus.map((r) => [r.status, r.n])) },
    revenue: { confirmedCents: toNumber(revenue?.total) },
    getcoin: {
      // "emitido" = créditos; "gasto" = débitos (inclui ajustes negativos). Por tipo para detalhe.
      issuedCents: issued,
      spentCents: spent,
      byType: ledger,
    },
    gets: { last24h: gets24h?.n ?? 0 },
    // D12: receita de taxas do marketplace (Σ fee_cents dos pedidos pagos)
    market: await marketFeeRevenue(db),
    // Fila de trabalho do painel: o que espera uma ação da equipe
    pending: await pendingWork(db),
  }
}

async function pendingWork(db: AppContext['db']) {
  const [[w], prizes] = await Promise.all([
    db.select({ n: count(), total: sum(withdrawals.amountCents) }).from(withdrawals).where(eq(withdrawals.status, 'PENDING')),
    db.select({ status: prizeDeliveries.status, n: count() }).from(prizeDeliveries).groupBy(prizeDeliveries.status),
  ])
  const byStatus = Object.fromEntries(prizes.map((p) => [p.status, p.n]))
  return {
    withdrawals: { count: w?.n ?? 0, totalCents: toNumber(w?.total) },
    prizesToShip: byStatus.PREPARING ?? 0,
    prizesAwaitingAddress: byStatus.AWAITING_ADDRESS ?? 0,
  }
}

// ---------- usuários ----------

export async function listUsers(ctx: AppContext, q: In<typeof listUsersQuery>) {
  const conds: SQL[] = []
  if (q.q) {
    const cpf = normalizeCpf(q.q)
    const term = `%${escapeLike(q.q)}%`
    conds.push(cpf ? eq(users.cpf, cpf) : or(ilike(users.name, term), ilike(users.email, term))!)
  }
  if (q.role) conds.push(eq(users.role, q.role))
  if (q.status) conds.push(eq(users.status, q.status))
  if (q.level) conds.push(eq(users.level, q.level))
  const where = conds.length ? and(...conds) : undefined

  const [rows, [{ total } = { total: 0 }]] = await Promise.all([
    ctx.db
      .select()
      .from(users)
      .where(where)
      .orderBy(desc(users.createdAt), desc(users.id))
      .limit(q.pageSize)
      .offset(offsetOf(q)),
    ctx.db.select({ total: count() }).from(users).where(where),
  ])
  return paginated(rows.map(toAdminUser), total, q)
}

export async function getUser(ctx: AppContext, id: string) {
  const { db } = ctx
  const [u] = await db.select().from(users).where(eq(users.id, id))
  if (!u) throw notFound('Usuário não encontrado.')
  const [balanceCents, cashBalanceCents, [getsCount], [wins]] = await Promise.all([
    getBalance(db, id),
    getCashBalance(db, id),
    db.select({ n: count() }).from(gets).where(eq(gets.userId, id)),
    db
      .select({ n: count() })
      .from(vibes)
      .innerJoin(gets, eq(gets.id, vibes.winnerGetId))
      .where(eq(gets.userId, id)),
  ])
  return { ...toAdminUser(u), balanceCents, cashBalanceCents, getsCount: getsCount?.n ?? 0, wins: wins?.n ?? 0 }
}

/** Regras: ninguém muda a própria role/status; último ADMIN ativo não pode ser rebaixado/suspenso. */
export async function patchUser(ctx: AppContext, actor: AuthInfo, id: string, input: In<typeof patchUserSchema>, meta: RequestMeta) {
  if (actor.userId === id) throw forbidden('Você não pode alterar a própria role ou status.', 'SELF_CHANGE_FORBIDDEN')

  const result = await ctx.db.transaction(async (tx) => {
    const [target] = await tx.select().from(users).where(eq(users.id, id)).for('update')
    if (!target) throw notFound('Usuário não encontrado.')
    if (target.status === 'DELETED') throw conflict('Conta excluída não pode ser alterada.', 'USER_DELETED')

    const demotesAdmin =
      target.role === 'ADMIN' &&
      target.status === 'ACTIVE' &&
      ((input.role !== undefined && input.role !== 'ADMIN') || input.status === 'SUSPENDED')
    if (demotesAdmin) {
      // Trava todos os ADMIN ativos para serializar rebaixamentos concorrentes.
      const admins = await tx
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.role, 'ADMIN'), eq(users.status, 'ACTIVE')))
        .for('update')
      if (admins.filter((a) => a.id !== id).length === 0) {
        throw conflict('Não é possível rebaixar ou suspender o último administrador ativo.', 'LAST_ADMIN')
      }
    }

    const patch: Partial<typeof users.$inferInsert> = {}
    if (input.role !== undefined && input.role !== target.role) patch.role = input.role
    if (input.status !== undefined && input.status !== target.status) patch.status = input.status
    if (Object.keys(patch).length === 0) return target

    const [updated] = await tx.update(users).set(patch).where(eq(users.id, id)).returning()
    // Suspensão e mudança de role derrubam as sessões (o token antigo carrega a role antiga).
    if (patch.status === 'SUSPENDED' || patch.role !== undefined) await revokeAllSessions(tx, id)
    // QA-24: suspensão cancela os anúncios ativos do marketplace e devolve os GetCoins em custódia
    if (patch.status === 'SUSPENDED') {
      const r = await cancelSellerListings(tx, id, 'Anúncio cancelado: conta suspensa')
      if (r.cancelled.length > 0) {
        await audit(tx, {
          actorId: actor.userId,
          action: 'MARKET_LISTINGS_CANCELLED_ON_SUSPEND',
          entity: 'user',
          entityId: id,
          metadata: { listingIds: r.cancelled, returnedCents: r.returnedCents },
          ip: meta.ip,
        })
      }
    }
    await audit(tx, {
      actorId: actor.userId,
      action: 'USER_UPDATED',
      entity: 'user',
      entityId: id,
      metadata: {
        from: { role: target.role, status: target.status },
        to: { role: updated!.role, status: updated!.status },
        reason: input.reason ?? null,
      },
      ip: meta.ip,
    })
    return updated!
  })
  return toAdminUser(result)
}

export async function adjustWallet(
  ctx: AppContext,
  actor: AuthInfo,
  userId: string,
  input: In<typeof walletAdjustmentSchema>,
  meta: RequestMeta,
) {
  if (actor.userId === userId) throw forbidden('Você não pode ajustar a própria carteira.', 'SELF_ADJUST_FORBIDDEN')
  const [target] = await ctx.db.select({ status: users.status }).from(users).where(eq(users.id, userId))
  if (!target) throw notFound('Usuário não encontrado.')
  if (target.status === 'DELETED') throw conflict('Conta excluída.', 'USER_DELETED')

  const entry = await ctx.db.transaction(async (tx) => {
    const e = await applyWalletMovement(tx, {
      userId,
      amountCents: input.amountCents,
      type: 'ADJUSTMENT',
      referenceType: 'admin',
      reason: input.reason,
      createdById: actor.userId,
    })
    await audit(tx, {
      actorId: actor.userId,
      action: 'WALLET_ADJUSTED',
      entity: 'user',
      entityId: userId,
      metadata: { amountCents: input.amountCents, reason: input.reason, ledgerId: e.id },
      ip: meta.ip,
    })
    return e
  })
  return { ledgerEntry: entry, balanceCents: entry.balanceAfterCents }
}

/** D6 — ajuste manual do saldo em R$ (suporte, correções). Mesmas regras do ajuste de GetCoin. */
export async function adjustCash(
  ctx: AppContext,
  actor: AuthInfo,
  userId: string,
  input: In<typeof walletAdjustmentSchema>,
  meta: RequestMeta,
) {
  if (actor.userId === userId) throw forbidden('Você não pode ajustar o próprio saldo.', 'SELF_ADJUST_FORBIDDEN')
  const [target] = await ctx.db.select({ status: users.status }).from(users).where(eq(users.id, userId))
  if (!target) throw notFound('Usuário não encontrado.')
  if (target.status === 'DELETED') throw conflict('Conta excluída.', 'USER_DELETED')

  const entry = await ctx.db.transaction(async (tx) => {
    const e = await applyCashMovement(tx, {
      userId,
      amountCents: input.amountCents,
      type: 'ADJUSTMENT',
      referenceType: 'admin',
      reason: input.reason,
      createdById: actor.userId,
    })
    await audit(tx, {
      actorId: actor.userId,
      action: 'CASH_ADJUSTED',
      entity: 'user',
      entityId: userId,
      metadata: { amountCents: input.amountCents, reason: input.reason, ledgerId: e.id },
      ip: meta.ip,
    })
    return e
  })
  return { ledgerEntry: entry, balanceCents: entry.balanceAfterCents }
}

// ---------- produtos ----------

export async function listProducts(ctx: AppContext, q: In<typeof listProductsQuery>) {
  const conds: SQL[] = []
  if (q.q) conds.push(ilike(products.name, `%${escapeLike(q.q)}%`))
  if (q.category) conds.push(eq(products.category, q.category))
  const where = conds.length ? and(...conds) : undefined
  const [rows, [{ total } = { total: 0 }]] = await Promise.all([
    ctx.db.select().from(products).where(where).orderBy(products.name).limit(q.pageSize).offset(offsetOf(q)),
    ctx.db.select({ total: count() }).from(products).where(where),
  ])
  return paginated(rows, total, q)
}

/** imageUrl https:// só de hosts em IMAGE_HOSTS (QA-13). Caminhos relativos já foram validados no schema. */
function assertImageHost(ctx: AppContext, imageUrl: string | null | undefined) {
  if (!imageUrl || imageUrl.startsWith('/')) return
  let host: string
  try {
    host = new URL(imageUrl).hostname.toLowerCase()
  } catch {
    throw new AppError(400, 'VALIDATION_ERROR', 'imageUrl inválida.')
  }
  const hosts = ctx.env.IMAGE_HOSTS.map((h) => h.toLowerCase())
  if (hosts.length === 0 && !ctx.env.isProduction) return
  if (!hosts.includes(host)) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Host de imagem não permitido.', [
      { path: 'imageUrl', message: `Hosts permitidos: ${ctx.env.IMAGE_HOSTS.join(', ') || '(nenhum)'}` },
    ])
  }
}

/** D10: capa e cada foto da galeria passam pela mesma regra de host. */
function assertProductImages(ctx: AppContext, p: { imageUrl?: string | null | undefined; images?: string[] | undefined }) {
  assertImageHost(ctx, p.imageUrl)
  for (const url of p.images ?? []) assertImageHost(ctx, url)
}

export async function createProduct(ctx: AppContext, actor: AuthInfo, input: In<typeof createProductSchema>, meta: RequestMeta) {
  assertProductImages(ctx, input)
  try {
    return await ctx.db.transaction(async (tx) => {
      const [p] = await tx
        .insert(products)
        .values({ ...input, imageUrl: input.imageUrl ?? null, description: input.description ?? null })
        .returning()
      await audit(tx, { actorId: actor.userId, action: 'PRODUCT_CREATED', entity: 'product', entityId: p!.id, metadata: { slug: p!.slug }, ip: meta.ip })
      return p!
    })
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict('Já existe um produto com esse slug.', 'SLUG_TAKEN')
    throw err
  }
}

export async function patchProduct(
  ctx: AppContext,
  actor: AuthInfo,
  id: string,
  input: In<typeof patchProductSchema>,
  meta: RequestMeta,
) {
  if (Object.keys(input).length === 0) throw new AppError(400, 'VALIDATION_ERROR', 'Nada para atualizar.')
  assertProductImages(ctx, input)
  try {
    return await ctx.db.transaction(async (tx) => {
      const [p] = await tx.update(products).set(input).where(eq(products.id, id)).returning()
      if (!p) throw notFound('Produto não encontrado.')
      await audit(tx, { actorId: actor.userId, action: 'PRODUCT_UPDATED', entity: 'product', entityId: id, metadata: { fields: Object.keys(input) }, ip: meta.ip })
      return p
    })
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict('Já existe um produto com esse slug.', 'SLUG_TAKEN')
    throw err
  }
}

// ---------- Vibes ----------

export async function listVibes(ctx: AppContext, q: In<typeof listVibesQuery>) {
  const conds: SQL[] = []
  if (q.status) conds.push(eq(vibes.status, q.status))
  if (q.productId) conds.push(eq(vibes.productId, q.productId))
  const where = conds.length ? and(...conds) : undefined
  const [rows, [{ total } = { total: 0 }]] = await Promise.all([
    ctx.db
      .select({ vibe: vibes, product: { id: products.id, name: products.name, slug: products.slug, category: products.category, imageUrl: products.imageUrl } })
      .from(vibes)
      .innerJoin(products, eq(products.id, vibes.productId))
      .where(where)
      .orderBy(desc(vibes.createdAt), desc(vibes.id))
      .limit(q.pageSize)
      .offset(offsetOf(q)),
    ctx.db.select({ total: count() }).from(vibes).where(where),
  ])
  const stats = await vibeStats(
    ctx.db,
    rows.map((r) => r.vibe.id),
  )
  return paginated(
    rows.map((r) => ({ ...r.vibe, product: r.product, ...stats.get(r.vibe.id)! })),
    total,
    q,
  )
}

/** Vibe com o produto completo (fotos, ficha técnica), para a tela de edição do painel. */
export async function getVibe(ctx: AppContext, id: string) {
  const [row] = await ctx.db
    .select({ vibe: vibes, product: products })
    .from(vibes)
    .innerJoin(products, eq(products.id, vibes.productId))
    .where(eq(vibes.id, id))
  if (!row) throw notFound('Vibe não encontrada.')
  const [stats, [same]] = await Promise.all([
    vibeStats(ctx.db, [id]),
    // O produto pode estar em outras Vibes: editar o produto muda todas elas.
    ctx.db.select({ n: count() }).from(vibes).where(eq(vibes.productId, row.product.id)),
  ])
  return { ...row.vibe, product: row.product, ...stats.get(id)!, productVibesCount: same?.n ?? 1 }
}

function assertVibeDatesForStatus(input: { status: string; endsAt: Date }) {
  if ((input.status === 'LIVE' || input.status === 'SCHEDULED') && input.endsAt <= new Date()) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Uma Vibe LIVE/SCHEDULED precisa terminar no futuro.')
  }
}

/**
 * Insere a Vibe dentro da transação. `defaultCashbackPercent` vem das configurações (D3) e deve ser lido
 * ANTES de abrir a transação (ler fora da transação enquanto ela está aberta trava o PGlite, que tem 1 conexão).
 */
async function insertVibe(
  tx: Tx,
  defaultCashbackPercent: number,
  actor: AuthInfo,
  input: In<typeof createVibeSchema>,
  meta: RequestMeta,
) {
  const cashbackPercent = input.cashbackPercent ?? defaultCashbackPercent
  const [v] = await tx
    .insert(vibes)
    .values({ ...input, cashbackPercent, goalGets: input.goalGets ?? null })
    .returning()
  await audit(tx, {
    actorId: actor.userId,
    action: 'VIBE_CREATED',
    entity: 'vibe',
    entityId: v!.id,
    metadata: { slug: v!.slug, status: v!.status, cashbackPercent },
    ip: meta.ip,
  })
  return v!
}

export async function createVibe(ctx: AppContext, actor: AuthInfo, input: In<typeof createVibeSchema>, meta: RequestMeta) {
  const [product] = await ctx.db.select({ id: products.id }).from(products).where(eq(products.id, input.productId))
  if (!product) throw notFound('Produto não encontrado.')
  assertVibeDatesForStatus(input)
  const { defaultCashbackPercent } = await ctx.settings.get()
  try {
    return await ctx.db.transaction((tx) => insertVibe(tx, defaultCashbackPercent, actor, input, meta))
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict('Já existe uma Vibe com esse slug.', 'SLUG_TAKEN')
    throw err
  }
}

/** D5: produto + Vibe numa única transação (se a Vibe falhar, o produto não fica criado). */
export async function createAuction(ctx: AppContext, actor: AuthInfo, input: In<typeof createAuctionSchema>, meta: RequestMeta) {
  assertProductImages(ctx, input.product)
  assertVibeDatesForStatus(input.vibe)
  const { defaultCashbackPercent } = await ctx.settings.get()
  try {
    return await ctx.db.transaction(async (tx) => {
      const [p] = await tx
        .insert(products)
        .values({ ...input.product, imageUrl: input.product.imageUrl ?? null, description: input.product.description ?? null })
        .returning()
      await audit(tx, { actorId: actor.userId, action: 'PRODUCT_CREATED', entity: 'product', entityId: p!.id, metadata: { slug: p!.slug, via: 'auction' }, ip: meta.ip })
      const v = await insertVibe(tx, defaultCashbackPercent, actor, { ...input.vibe, productId: p!.id }, meta)
      await audit(tx, { actorId: actor.userId, action: 'AUCTION_CREATED', entity: 'vibe', entityId: v.id, metadata: { productId: p!.id }, ip: meta.ip })
      return { product: p!, vibe: v }
    })
  } catch (err) {
    if (isUniqueViolation(err)) {
      const which = isUniqueViolation(err, 'products_slug_uq') ? 'produto' : 'Vibe'
      throw conflict(`Já existe um(a) ${which} com esse slug.`, 'SLUG_TAKEN')
    }
    throw err
  }
}

const TRANSITIONS: Record<string, string[]> = {
  DRAFT: ['SCHEDULED', 'LIVE', 'CANCELLED'],
  SCHEDULED: ['DRAFT', 'LIVE', 'CANCELLED'],
  LIVE: ['CANCELLED'],
  ENDED: [],
  CANCELLED: [],
}

/**
 * Edição de Vibe. Regras:
 * - ENDED/CANCELLED são imutáveis;
 * - LIVE só permite ajustar endsAt/goalGets ou cancelar (valores monetários ficam congelados);
 * - LIVE -> ENDED só via /close (settlement).
 */
export async function patchVibe(ctx: AppContext, actor: AuthInfo, id: string, input: In<typeof patchVibeSchema>, meta: RequestMeta) {
  if (Object.keys(input).length === 0) throw new AppError(400, 'VALIDATION_ERROR', 'Nada para atualizar.')
  const cfg = await ctx.settings.get() // lido antes da transação (PGlite)
  try {
    return await ctx.db.transaction(async (tx) => {
      const [v] = await tx.select().from(vibes).where(eq(vibes.id, id)).for('update')
      if (!v) throw notFound('Vibe não encontrada.')
      if (v.status === 'ENDED' || v.status === 'CANCELLED') {
        throw conflict('Esta Vibe já foi encerrada ou cancelada.', 'VIBE_FINISHED')
      }
      if (input.status && input.status !== v.status && !TRANSITIONS[v.status]!.includes(input.status)) {
        throw conflict(`Transição de status inválida: ${v.status} -> ${input.status}.`, 'INVALID_TRANSITION')
      }
      // LIVE com prazo vencido aguardando o encerramento: não pode ser reaberta nem editada (QA-11).
      if (v.status === 'LIVE' && v.endsAt <= new Date() && input.status !== 'CANCELLED') {
        throw conflict(
          'O prazo desta Vibe já terminou; ela aguarda o encerramento. Use POST /admin/vibes/:id/close.',
          'VIBE_EXPIRED',
        )
      }
      if (v.status === 'LIVE') {
        const allowed = new Set(['endsAt', 'goalGets', 'status'])
        const blocked = Object.keys(input).filter((k) => !allowed.has(k))
        if (blocked.length) {
          throw conflict(`Com a Vibe em andamento só é possível alterar endsAt e goalGets (recebido: ${blocked.join(', ')}).`, 'VIBE_LOCKED')
        }
      }

      if (input.status === 'CANCELLED') {
        const r = await cancelVibe(tx, id)
        await audit(tx, { actorId: actor.userId, action: 'VIBE_CANCELLED', entity: 'vibe', entityId: id, metadata: r, ip: meta.ip })
        const [after] = await tx.select().from(vibes).where(eq(vibes.id, id))
        return after!
      }

      const startsAt = input.startsAt ?? v.startsAt
      const endsAt = input.endsAt ?? v.endsAt
      if (endsAt <= startsAt) throw new AppError(400, 'VALIDATION_ERROR', 'endsAt deve ser depois de startsAt.')
      if (endsAt.getTime() - startsAt.getTime() > VIBE_MAX_DURATION_MS) {
        throw new AppError(400, 'VALIDATION_ERROR', 'Uma Vibe dura no máximo 15 dias.')
      }
      if (v.status === 'LIVE' && input.endsAt && input.endsAt <= new Date()) {
        throw new AppError(400, 'VALIDATION_ERROR', 'Para encerrar agora use POST /admin/vibes/:id/close.')
      }
      const nextStatus = input.status ?? v.status
      if ((nextStatus === 'LIVE' || nextStatus === 'SCHEDULED') && endsAt <= new Date()) {
        throw new AppError(400, 'VALIDATION_ERROR', 'Uma Vibe LIVE/SCHEDULED precisa terminar no futuro.')
      }

      const [updated] = await tx.update(vibes).set(input).where(eq(vibes.id, id)).returning()
      // QA-17: encurtou o fim de uma Vibe LIVE -> nenhum pagamento pendente pode vencer depois do novo prazo.
      if (v.status === 'LIVE' && input.endsAt && input.endsAt < v.endsAt) {
        const { paymentDeadline } = vibeDeadlines(input.endsAt, cfg)
        await tx.execute(sql`
          UPDATE payments p SET expires_at = LEAST(p.expires_at, ${paymentDeadline.toISOString()}::timestamptz)
          FROM gets g
          WHERE g.id = p.get_id AND g.vibe_id = ${id} AND p.status = 'PENDING'`)
      }
      await audit(tx, {
        actorId: actor.userId,
        action: 'VIBE_UPDATED',
        entity: 'vibe',
        entityId: id,
        metadata: { fields: Object.keys(input), from: v.status, to: updated!.status },
        ip: meta.ip,
      })
      return updated!
    })
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict('Já existe uma Vibe com esse slug.', 'SLUG_TAKEN')
    throw err
  }
}

export function closeVibe(ctx: AppContext, actor: AuthInfo, id: string, meta: RequestMeta) {
  return settleVibe(ctx, id, { actorId: actor.userId, ip: meta.ip })
}

// ---------- Gets (leitura) ----------

export async function listGets(ctx: AppContext, q: In<typeof listGetsQuery>) {
  const conds: SQL[] = []
  if (q.vibeId) conds.push(eq(gets.vibeId, q.vibeId))
  if (q.userId) conds.push(eq(gets.userId, q.userId))
  if (q.status) conds.push(eq(gets.status, q.status))
  const where = conds.length ? and(...conds) : undefined
  const [rows, [{ total } = { total: 0 }]] = await Promise.all([
    ctx.db
      .select({
        id: gets.id,
        vibeId: gets.vibeId,
        userId: gets.userId,
        userName: users.name,
        cashCents: gets.cashCents,
        getcoinCents: gets.getcoinCents,
        totalCents: gets.totalCents,
        status: gets.status,
        createdAt: gets.createdAt,
        payment: { id: payments.id, status: payments.status, method: payments.method, externalId: payments.externalId, paidAt: payments.paidAt },
      })
      .from(gets)
      .innerJoin(users, eq(users.id, gets.userId))
      .leftJoin(payments, eq(payments.getId, gets.id))
      .where(where)
      .orderBy(desc(gets.createdAt), desc(gets.id))
      .limit(q.pageSize)
      .offset(offsetOf(q)),
    ctx.db.select({ total: count() }).from(gets).where(where),
  ])
  return paginated(rows, total, q)
}

// ---------- audit ----------

export async function listAuditLogs(ctx: AppContext, q: In<typeof listAuditQuery>) {
  const conds: SQL[] = []
  if (q.action) conds.push(eq(auditLogs.action, q.action))
  if (q.entity) conds.push(eq(auditLogs.entity, q.entity))
  if (q.entityId) conds.push(eq(auditLogs.entityId, q.entityId))
  if (q.actorId) conds.push(eq(auditLogs.actorId, q.actorId))
  if (q.from) conds.push(gte(auditLogs.createdAt, q.from))
  if (q.to) conds.push(lte(auditLogs.createdAt, q.to))
  const where = conds.length ? and(...conds) : undefined
  const [rows, [{ total } = { total: 0 }]] = await Promise.all([
    ctx.db
      .select({ log: auditLogs, actorName: users.name })
      .from(auditLogs)
      .leftJoin(users, eq(users.id, auditLogs.actorId))
      .where(where)
      .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
      .limit(q.pageSize)
      .offset(offsetOf(q)),
    ctx.db.select({ total: count() }).from(auditLogs).where(where),
  ])
  // Nome de quem agiu, para o histórico do painel não mostrar só o id.
  return paginated(rows.map((r) => ({ ...r.log, actorName: r.actorName })), total, q)
}

