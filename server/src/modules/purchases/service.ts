import { and, asc, count, desc, eq, sql } from 'drizzle-orm'
import type { z } from 'zod'
import type { AppContext, AuthInfo, RequestMeta } from '../../context.js'
import type { DbOrTx } from '../../db/client.js'
import { getcoinPackages, getcoinPurchases, payments, users } from '../../db/schema.js'
import { audit } from '../../lib/audit.js'
import { randomToken } from '../../lib/crypto.js'
import { AppError, conflict, forbidden, isUniqueViolation, notFound } from '../../lib/errors.js'
import { offsetOf, paginated, type Pagination } from '../../lib/pagination.js'
import { applyCashMovement, getCashBalance } from '../cash/service.js'
import { creditPurchase, mockProvider } from '../payments/service.js'
import { getBalance } from '../wallet/service.js'
import type { createPackageSchema, createPurchaseSchema, patchPackageSchema } from './schemas.js'

type In<T extends z.ZodType> = z.output<T>

export const packagePublicColumns = {
  id: getcoinPackages.id,
  name: getcoinPackages.name,
  getcoinsCents: getcoinPackages.getcoinsCents,
  bonusCents: getcoinPackages.bonusCents,
  priceCents: getcoinPackages.priceCents,
  sortOrder: getcoinPackages.sortOrder,
}

/** Público: só pacotes ativos, na ordem definida pelo admin. */
export function listActivePackages(db: DbOrTx) {
  return db
    .select(packagePublicColumns)
    .from(getcoinPackages)
    .where(eq(getcoinPackages.active, true))
    .orderBy(asc(getcoinPackages.sortOrder), asc(getcoinPackages.priceCents))
}

/** Formato de compra devolvido ao dono (contrato do front). */
async function loadPurchase(db: DbOrTx, userId: string, purchaseId: string) {
  const [row] = await db
    .select({
      p: getcoinPurchases,
      pay: {
        id: payments.id,
        status: payments.status,
        pixCopyPaste: payments.pixCopyPaste,
        expiresAt: payments.expiresAt,
        paidAt: payments.paidAt,
      },
    })
    .from(getcoinPurchases)
    .leftJoin(payments, eq(payments.purchaseId, getcoinPurchases.id))
    .where(and(eq(getcoinPurchases.id, purchaseId), eq(getcoinPurchases.userId, userId)))
  if (!row) return null
  return toPurchaseView(row.p, row.pay)
}

function toPurchaseView(
  p: typeof getcoinPurchases.$inferSelect,
  pay: { id: string; status: string; pixCopyPaste: string | null; expiresAt: Date; paidAt: Date | null } | null,
) {
  return {
    id: p.id,
    package: { id: p.packageId, name: p.packageName, getcoinsCents: p.getcoinsCents, bonusCents: p.bonusCents, priceCents: p.priceCents },
    method: p.method,
    status: p.status,
    payment: pay,
    createdAt: p.createdAt,
  }
}

export async function getMyPurchase(ctx: AppContext, userId: string, id: string) {
  const v = await loadPurchase(ctx.db, userId, id)
  // Compra de outro usuário = 404 (sem vazar existência)
  if (!v) throw notFound('Compra não encontrada.')
  return v
}

export async function listMyPurchases(ctx: AppContext, userId: string, p: Pagination) {
  const where = eq(getcoinPurchases.userId, userId)
  const [rows, [{ total } = { total: 0 }]] = await Promise.all([
    ctx.db
      .select({
        p: getcoinPurchases,
        pay: {
          id: payments.id,
          status: payments.status,
          pixCopyPaste: payments.pixCopyPaste,
          expiresAt: payments.expiresAt,
          paidAt: payments.paidAt,
        },
      })
      .from(getcoinPurchases)
      .leftJoin(payments, eq(payments.purchaseId, getcoinPurchases.id))
      .where(where)
      .orderBy(desc(getcoinPurchases.createdAt), desc(getcoinPurchases.id))
      .limit(p.pageSize)
      .offset(offsetOf(p)),
    ctx.db.select({ total: count() }).from(getcoinPurchases).where(where),
  ])
  return paginated(
    rows.map((r) => toPurchaseView(r.p, r.pay)),
    total,
    p,
  )
}

/**
 * D7 — compra de pacote. Idempotente por (usuário, Idempotency-Key).
 * PIX/CARD: cria compra PENDING_PAYMENT + cobrança MOCK (crédito quando o pagamento vira PAID).
 * BALANCE: debita o saldo em R$ e credita o GetCoin na mesma transação (status PAID na resposta).
 */
export async function createPurchase(
  ctx: AppContext,
  userId: string,
  input: In<typeof createPurchaseSchema>,
  idempotencyKey: string,
  meta: RequestMeta,
) {
  const { db, env } = ctx
  const replay = async () => {
    const [existing] = await db
      .select()
      .from(getcoinPurchases)
      .where(and(eq(getcoinPurchases.userId, userId), eq(getcoinPurchases.idempotencyKey, idempotencyKey)))
    if (!existing) return null
    const sameTarget = input.packageId
      ? existing.packageId === input.packageId
      : existing.packageId === null && existing.getcoinsCents === input.customGetcoinsCents
    if (!sameTarget || existing.method !== input.method) {
      throw conflict('Idempotency-Key já usada com outros dados.', 'IDEMPOTENCY_KEY_REUSED')
    }
    return { purchase: (await loadPurchase(db, userId, existing.id))!, replayed: true }
  }
  const prior = await replay()
  if (prior) return withBalances(ctx, userId, prior)

  const [u] = await db.select({ status: users.status, verified: users.emailVerifiedAt }).from(users).where(eq(users.id, userId))
  if (!u || u.status !== 'ACTIVE') throw forbidden('Conta inativa.', 'ACCOUNT_INACTIVE')
  if (!u.verified) throw forbidden('Confirme seu e-mail antes de comprar GetCoin.', 'EMAIL_NOT_VERIFIED')

  const pkg = await resolveSnapshot(ctx, input)

  try {
    const purchaseId = await db.transaction(async (tx) => {
      const now = new Date()
      const paid = input.method === 'BALANCE'
      const [purchase] = await tx
        .insert(getcoinPurchases)
        .values({
          userId,
          packageId: pkg.id,
          packageName: pkg.name,
          getcoinsCents: pkg.getcoinsCents,
          bonusCents: pkg.bonusCents,
          priceCents: pkg.priceCents,
          method: input.method,
          status: paid ? 'PAID' : 'PENDING_PAYMENT',
          idempotencyKey,
        })
        .returning()
      if (paid) {
        const [pay] = await tx
          .insert(payments)
          .values({
            purchaseId: purchase!.id,
            provider: 'INTERNAL',
            method: 'BALANCE',
            status: 'PAID',
            amountCents: pkg.priceCents,
            externalId: `bal_${randomToken(16)}`,
            expiresAt: now,
            paidAt: now,
          })
          .returning({ id: payments.id })
        // Ordem de locks: carteira GetCoin -> carteira R$ (mesma ordem do Get pago com saldo).
        await creditPurchase(tx, purchase!)
        await applyCashMovement(tx, {
          userId,
          amountCents: -pkg.priceCents,
          type: 'GETCOIN_PURCHASE',
          referenceType: 'purchase',
          referenceId: purchase!.id,
          reason: pkg.id ? `Compra do pacote ${pkg.name}` : `Compra avulsa de GetCoin`,
        })
        await audit(tx, {
          actorId: userId,
          action: 'PAYMENT_PAID',
          entity: 'payment',
          entityId: pay!.id,
          metadata: { method: 'BALANCE', purchaseId: purchase!.id },
          ip: meta.ip,
        })
      } else {
        const charge = mockProvider.createCharge({ amountCents: pkg.priceCents, method: input.method as 'PIX' | 'CARD' })
        await tx.insert(payments).values({
          purchaseId: purchase!.id,
          provider: 'MOCK',
          method: input.method,
          status: 'PENDING',
          amountCents: pkg.priceCents,
          externalId: charge.externalId,
          pixCopyPaste: charge.pixCopyPaste,
          expiresAt: new Date(now.getTime() + env.PAYMENT_TTL_MINUTES * 60_000),
        })
      }
      await audit(tx, {
        actorId: userId,
        action: 'GETCOIN_PURCHASE_CREATED',
        entity: 'purchase',
        entityId: purchase!.id,
        metadata: { packageId: pkg.id, custom: pkg.id === null, getcoinsCents: pkg.getcoinsCents, method: input.method, priceCents: pkg.priceCents },
        ip: meta.ip,
      })
      return purchase!.id
    })
    return withBalances(ctx, userId, { purchase: (await loadPurchase(db, userId, purchaseId))!, replayed: false })
  } catch (err) {
    if (isUniqueViolation(err, 'getcoin_purchases_user_idempotency_uq')) {
      const again = await replay()
      if (again) return withBalances(ctx, userId, again)
    }
    throw err
  }
}

async function withBalances<T extends object>(ctx: AppContext, userId: string, r: T) {
  const [cashBalanceCents, getcoinBalanceCents] = await Promise.all([getCashBalance(ctx.db, userId), getBalance(ctx.db, userId)])
  return { ...r, balances: { cashBalanceCents, getcoinBalanceCents } }
}

/**
 * D11: valores da compra. Pacote ativo, ou avulsa: preço = GetCoins x preço unitário (configurações), sem bônus.
 * Snapshot avulso: packageId null, packageName "Avulso".
 */
async function resolveSnapshot(ctx: AppContext, input: In<typeof createPurchaseSchema>) {
  if (input.packageId) {
    const [pkg] = await ctx.db.select().from(getcoinPackages).where(eq(getcoinPackages.id, input.packageId))
    if (!pkg || !pkg.active) throw notFound('Pacote não encontrado.', 'PACKAGE_NOT_FOUND')
    return { id: pkg.id as string | null, name: pkg.name, getcoinsCents: pkg.getcoinsCents, bonusCents: pkg.bonusCents, priceCents: pkg.priceCents }
  }
  const cfg = await ctx.settings.get()
  const qty = input.customGetcoinsCents!
  if (!cfg.getcoinCustomEnabled) throw new AppError(422, 'CUSTOM_PURCHASE_DISABLED', 'Compra avulsa de GetCoin indisponível no momento.')
  if (qty < cfg.getcoinCustomMinCents || qty > cfg.getcoinCustomMaxCents) {
    throw new AppError(422, 'CUSTOM_AMOUNT_OUT_OF_RANGE', 'Quantidade fora da faixa permitida para compra avulsa.', [
      { path: 'customGetcoinsCents', message: `Entre ${cfg.getcoinCustomMinCents} e ${cfg.getcoinCustomMaxCents}.` },
    ])
  }
  return { id: null, name: CUSTOM_PACKAGE_NAME, getcoinsCents: qty, bonusCents: 0, priceCents: (qty / 100) * cfg.getcoinUnitPriceCents }
}

export const CUSTOM_PACKAGE_NAME = 'Avulso'

/** Público: configuração da compra avulsa (sem dados de usuário). */
export async function customPurchaseConfig(ctx: AppContext) {
  const cfg = await ctx.settings.get()
  return {
    enabled: cfg.getcoinCustomEnabled,
    unitPriceCents: cfg.getcoinUnitPriceCents,
    minCents: cfg.getcoinCustomMinCents,
    maxCents: cfg.getcoinCustomMaxCents,
  }
}

// ---------- admin: pacotes ----------

/** Pacotes com contagem de compras: com alguma compra, o painel oferece desativar em vez de excluir. */
export async function listPackagesAdmin(ctx: AppContext) {
  const [packs, sales] = await Promise.all([
    ctx.db.select().from(getcoinPackages).orderBy(asc(getcoinPackages.sortOrder), asc(getcoinPackages.priceCents)),
    ctx.db
      .select({
        packageId: getcoinPurchases.packageId,
        total: count(),
        paid: sql<number>`count(*) filter (where ${getcoinPurchases.status} = 'PAID')`.mapWith(Number),
      })
      .from(getcoinPurchases)
      .groupBy(getcoinPurchases.packageId),
  ])
  const byPackage = new Map(sales.map((s) => [s.packageId, s]))
  return packs.map((p) => ({ ...p, purchasesCount: byPackage.get(p.id)?.total ?? 0, paidCount: byPackage.get(p.id)?.paid ?? 0 }))
}

export async function createPackage(ctx: AppContext, actor: AuthInfo, input: In<typeof createPackageSchema>, meta: RequestMeta) {
  return ctx.db.transaction(async (tx) => {
    const [p] = await tx.insert(getcoinPackages).values(input).returning()
    await audit(tx, { actorId: actor.userId, action: 'PACKAGE_CREATED', entity: 'package', entityId: p!.id, metadata: { ...input }, ip: meta.ip })
    return p!
  })
}

export async function patchPackage(
  ctx: AppContext,
  actor: AuthInfo,
  id: string,
  input: In<typeof patchPackageSchema>,
  meta: RequestMeta,
) {
  return ctx.db.transaction(async (tx) => {
    const [before] = await tx.select().from(getcoinPackages).where(eq(getcoinPackages.id, id)).for('update')
    if (!before) throw notFound('Pacote não encontrado.')
    // Compras já feitas guardam snapshot dos valores; mudar o pacote não altera o passado.
    const [p] = await tx.update(getcoinPackages).set(input).where(eq(getcoinPackages.id, id)).returning()
    await audit(tx, { actorId: actor.userId, action: 'PACKAGE_UPDATED', entity: 'package', entityId: id, metadata: { changes: input }, ip: meta.ip })
    return p!
  })
}

/** Só apaga pacote nunca comprado; com compras, desative (active:false). */
export async function deletePackage(ctx: AppContext, actor: AuthInfo, id: string, meta: RequestMeta) {
  return ctx.db.transaction(async (tx) => {
    const [before] = await tx.select().from(getcoinPackages).where(eq(getcoinPackages.id, id)).for('update')
    if (!before) throw notFound('Pacote não encontrado.')
    const [{ n } = { n: 0 }] = await tx.select({ n: count() }).from(getcoinPurchases).where(eq(getcoinPurchases.packageId, id))
    if (n > 0) throw new AppError(409, 'PACKAGE_IN_USE', 'Pacote já foi comprado; desative-o em vez de excluir.')
    await tx.delete(getcoinPackages).where(eq(getcoinPackages.id, id))
    await audit(tx, { actorId: actor.userId, action: 'PACKAGE_DELETED', entity: 'package', entityId: id, metadata: { name: before.name }, ip: meta.ip })
  })
}
