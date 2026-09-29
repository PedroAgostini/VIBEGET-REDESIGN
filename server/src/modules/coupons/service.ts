import { and, count, desc, eq, ilike, type SQL } from 'drizzle-orm'
import type { z } from 'zod'
import type { AppContext, AuthInfo, RequestMeta } from '../../context.js'
import { couponRedemptions, coupons, users } from '../../db/schema.js'
import { audit } from '../../lib/audit.js'
import { AppError, conflict, isUniqueViolation, notFound } from '../../lib/errors.js'
import { escapeLike, offsetOf, paginated, type Pagination } from '../../lib/pagination.js'
import { applyWalletMovement } from '../wallet/service.js'
import type { CreateCouponInput, listCouponsQuery, PatchCouponInput } from './schemas.js'

/** Resposta ÚNICA para código inexistente, inativo, fora da validade, esgotado ou já usado (D4). */
export const couponUnavailable = () => new AppError(422, 'COUPON_UNAVAILABLE', 'Cupom inválido ou indisponível.')

const CODE_RE = /^[A-Z0-9_-]{3,40}$/

/** Motivo interno (só para o audit log, nunca para o cliente). */
class CouponRejected extends Error {
  constructor(public readonly reason: string) {
    super(reason)
  }
}

/**
 * Resgate atômico (D4):
 * trava a linha do cupom (FOR UPDATE), confere validade/limites, grava o resgate com seq (UNIQUE(coupon,user,seq)),
 * credita GetCoin pelo livro-razão (tipo COUPON) e incrementa o contador — tudo na mesma transação.
 * "Só contas novas" = conta criada depois da criação do cupom.
 */
export async function redeemCoupon(ctx: Pick<AppContext, 'db'>, userId: string, rawCode: string, meta: RequestMeta) {
  const code = rawCode.trim().toUpperCase()
  try {
    if (!CODE_RE.test(code)) throw new CouponRejected('bad_format')
    return await ctx.db.transaction(async (tx) => {
      const [coupon] = await tx.select().from(coupons).where(eq(coupons.code, code)).for('update')
      if (!coupon) throw new CouponRejected('not_found')
      const now = new Date()
      if (!coupon.active) throw new CouponRejected('inactive')
      if (coupon.startsAt > now) throw new CouponRejected('not_started')
      if (coupon.endsAt && coupon.endsAt <= now) throw new CouponRejected('expired')
      if (coupon.maxRedemptions !== null && coupon.redemptionsCount >= coupon.maxRedemptions) {
        throw new CouponRejected('exhausted')
      }
      const [user] = await tx
        .select({ status: users.status, createdAt: users.createdAt })
        .from(users)
        .where(eq(users.id, userId))
      if (!user || user.status !== 'ACTIVE') throw new CouponRejected('user_inactive')
      if (coupon.newAccountsOnly && user.createdAt < coupon.createdAt) throw new CouponRejected('not_new_account')

      const [{ n: used } = { n: 0 }] = await tx
        .select({ n: count() })
        .from(couponRedemptions)
        .where(and(eq(couponRedemptions.couponId, coupon.id), eq(couponRedemptions.userId, userId)))
      if (used >= coupon.perUserLimit) throw new CouponRejected('user_limit')

      const entry = await applyWalletMovement(tx, {
        userId,
        amountCents: coupon.amountCents,
        type: 'COUPON',
        referenceType: 'coupon',
        referenceId: coupon.id,
        reason: `Cupom ${coupon.code}`,
      })
      await tx.insert(couponRedemptions).values({
        couponId: coupon.id,
        userId,
        seq: used + 1,
        amountCents: coupon.amountCents,
        ledgerId: entry.id,
      })
      await tx
        .update(coupons)
        .set({ redemptionsCount: coupon.redemptionsCount + 1 })
        .where(eq(coupons.id, coupon.id))
      await audit(tx, {
        actorId: userId,
        action: 'COUPON_REDEEMED',
        entity: 'coupon',
        entityId: coupon.id,
        metadata: { amountCents: coupon.amountCents, ledgerId: entry.id },
        ip: meta.ip,
      })
      return { amountCents: coupon.amountCents, balanceCents: entry.balanceAfterCents }
    })
  } catch (err) {
    const reason = err instanceof CouponRejected ? err.reason : isUniqueViolation(err) ? 'user_limit_race' : null
    if (reason === null) throw err
    await audit(ctx.db, {
      actorId: userId,
      action: 'COUPON_REDEEM_FAILED',
      entity: 'user',
      entityId: userId,
      metadata: { reason },
      ip: meta.ip,
    })
    throw couponUnavailable()
  }
}

// ---------- admin ----------

type ListQuery = z.output<typeof listCouponsQuery>

export async function listCoupons(ctx: AppContext, q: ListQuery) {
  const conds: SQL[] = []
  if (q.q) conds.push(ilike(coupons.code, `%${escapeLike(q.q.toUpperCase())}%`))
  if (q.active) conds.push(eq(coupons.active, q.active === 'true'))
  const where = conds.length ? and(...conds) : undefined
  const [rows, [{ total } = { total: 0 }]] = await Promise.all([
    ctx.db.select().from(coupons).where(where).orderBy(desc(coupons.createdAt), desc(coupons.id)).limit(q.pageSize).offset(offsetOf(q)),
    ctx.db.select({ total: count() }).from(coupons).where(where),
  ])
  return paginated(rows, total, q)
}

export async function createCoupon(ctx: AppContext, actor: AuthInfo, input: CreateCouponInput, meta: RequestMeta) {
  try {
    return await ctx.db.transaction(async (tx) => {
      const [c] = await tx
        .insert(coupons)
        .values({
          code: input.code,
          amountCents: input.amountCents,
          maxRedemptions: input.maxRedemptions ?? null,
          perUserLimit: input.perUserLimit,
          ...(input.startsAt ? { startsAt: input.startsAt } : {}),
          endsAt: input.endsAt ?? null,
          active: input.active,
          newAccountsOnly: input.newAccountsOnly,
          description: input.description ?? null,
          createdById: actor.userId,
        })
        .returning()
      await audit(tx, {
        actorId: actor.userId,
        action: 'COUPON_CREATED',
        entity: 'coupon',
        entityId: c!.id,
        metadata: { code: c!.code, amountCents: c!.amountCents, maxRedemptions: c!.maxRedemptions },
        ip: meta.ip,
      })
      return c!
    })
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict('Já existe um cupom com esse código.', 'CODE_TAKEN')
    throw err
  }
}

/** Valor e "só contas novas" ficam congelados depois do 1º resgate; limite total não pode ficar abaixo do já resgatado. */
export async function patchCoupon(ctx: AppContext, actor: AuthInfo, id: string, input: PatchCouponInput, meta: RequestMeta) {
  return ctx.db.transaction(async (tx) => {
    const [c] = await tx.select().from(coupons).where(eq(coupons.id, id)).for('update')
    if (!c) throw notFound('Cupom não encontrado.')
    if (c.redemptionsCount > 0 && (input.amountCents !== undefined || input.newAccountsOnly !== undefined)) {
      throw conflict('Valor e restrição de conta nova não mudam depois do primeiro resgate.', 'COUPON_LOCKED')
    }
    if (input.maxRedemptions !== undefined && input.maxRedemptions !== null && input.maxRedemptions < c.redemptionsCount) {
      throw new AppError(400, 'VALIDATION_ERROR', 'maxRedemptions não pode ser menor que os resgates já feitos.')
    }
    const startsAt = input.startsAt ?? c.startsAt
    const endsAt = input.endsAt === undefined ? c.endsAt : input.endsAt
    if (endsAt && endsAt <= startsAt) throw new AppError(400, 'VALIDATION_ERROR', 'endsAt deve ser depois de startsAt.')

    const [updated] = await tx.update(coupons).set(input).where(eq(coupons.id, id)).returning()
    await audit(tx, {
      actorId: actor.userId,
      action: 'COUPON_UPDATED',
      entity: 'coupon',
      entityId: id,
      metadata: { fields: Object.keys(input) },
      ip: meta.ip,
    })
    return updated!
  })
}

export async function listRedemptions(ctx: AppContext, couponId: string, p: Pagination) {
  const [c] = await ctx.db.select({ id: coupons.id }).from(coupons).where(eq(coupons.id, couponId))
  if (!c) throw notFound('Cupom não encontrado.')
  const where = eq(couponRedemptions.couponId, couponId)
  const [rows, [{ total } = { total: 0 }]] = await Promise.all([
    ctx.db
      .select({
        id: couponRedemptions.id,
        userId: couponRedemptions.userId,
        userName: users.name,
        userEmail: users.email,
        seq: couponRedemptions.seq,
        amountCents: couponRedemptions.amountCents,
        ledgerId: couponRedemptions.ledgerId,
        createdAt: couponRedemptions.createdAt,
      })
      .from(couponRedemptions)
      .innerJoin(users, eq(users.id, couponRedemptions.userId))
      .where(where)
      .orderBy(desc(couponRedemptions.createdAt), desc(couponRedemptions.id))
      .limit(p.pageSize)
      .offset(offsetOf(p)),
    ctx.db.select({ total: count() }).from(couponRedemptions).where(where),
  ])
  return paginated(rows, total, p)
}
