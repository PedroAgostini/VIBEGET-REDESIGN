import { and, count, desc, eq, gte, inArray, sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import type { AppContext, AuthInfo, RequestMeta } from '../../context.js'
import type { DbOrTx } from '../../db/client.js'
import { cashWallets, users, withdrawals, type Role, type Withdrawal } from '../../db/schema.js'
import { audit } from '../../lib/audit.js'
import { normalizeCpf } from '../../lib/cpf.js'
import { AppError, conflict, forbidden, isUniqueViolation, notFound } from '../../lib/errors.js'
import { offsetOf, paginated, type Pagination } from '../../lib/pagination.js'
import { maskPixKey } from '../../lib/presenters.js'
import { applyCashMovement, getCashBalance } from '../cash/service.js'

export type PixKeyType = 'CPF' | 'EMAIL' | 'PHONE' | 'RANDOM'

/** Normaliza e valida a chave conforme o tipo. Retorna null se inválida. */
export function normalizePixKey(type: PixKeyType, raw: string): string | null {
  const v = raw.trim()
  switch (type) {
    case 'CPF':
      return normalizeCpf(v)
    case 'EMAIL': {
      const e = v.toLowerCase()
      return z.email().max(77).safeParse(e).success ? e : null
    }
    case 'PHONE': {
      const d = v.replace(/[^\d]/g, '')
      const withCountry = d.startsWith('55') && d.length >= 12 ? d : `55${d}`
      return /^55\d{10,11}$/.test(withCountry) ? `+${withCountry}` : null
    }
    case 'RANDOM':
      return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v) ? v.toLowerCase() : null
  }
}

/** Visão do dono e do SUPPORT: chave sempre mascarada. */
export function toWithdrawalView(w: Withdrawal) {
  return {
    id: w.id,
    amountCents: w.amountCents,
    status: w.status,
    pixKeyType: w.pixKeyType,
    pixKeyMasked: maskPixKey(w.pixKeyType, w.pixKey),
    createdAt: w.createdAt,
    decidedAt: w.decidedAt,
    rejectReason: w.rejectReason,
  }
}

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * D6 — pedido de saque. Idempotente por (usuário, Idempotency-Key).
 * Exige e-mail verificado e CPF. Valor >= withdrawMinCents; soma das últimas 24 h (PENDING+PAID) <= withdrawDailyMaxCents.
 * Trava a carteira R$ ANTES de somar o limite diário: pedidos paralelos do mesmo usuário são serializados.
 * O valor é debitado na hora (reserva) com lançamento WITHDRAWAL.
 */
export async function requestWithdrawal(
  ctx: AppContext,
  userId: string,
  input: { amountCents: number; pixKeyType: PixKeyType; pixKey: string },
  idempotencyKey: string,
  meta: RequestMeta,
) {
  const { db } = ctx
  const pixKey = normalizePixKey(input.pixKeyType, input.pixKey)
  if (!pixKey) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Chave Pix inválida para o tipo informado.', [{ path: 'pixKey', message: 'Chave Pix inválida.' }])
  }

  const replay = async () => {
    const [w] = await db
      .select()
      .from(withdrawals)
      .where(and(eq(withdrawals.userId, userId), eq(withdrawals.idempotencyKey, idempotencyKey)))
    if (!w) return null
    if (w.amountCents !== input.amountCents || w.pixKeyType !== input.pixKeyType || w.pixKey !== pixKey) {
      throw conflict('Idempotency-Key já usada com outros dados.', 'IDEMPOTENCY_KEY_REUSED')
    }
    return { withdrawal: toWithdrawalView(w), replayed: true }
  }
  const prior = await replay()
  if (prior) return prior

  const [u] = await db.select().from(users).where(eq(users.id, userId))
  if (!u || u.status !== 'ACTIVE') throw forbidden('Conta inativa.', 'ACCOUNT_INACTIVE')
  if (!u.emailVerifiedAt) throw forbidden('Confirme seu e-mail antes de sacar.', 'EMAIL_NOT_VERIFIED')
  if (!u.cpf) throw new AppError(422, 'CPF_REQUIRED', 'Informe seu CPF no perfil antes de sacar.')
  // Saque só para chave do próprio titular. A do tipo CPF dá para conferir aqui; as outras o ADMIN confere antes de pagar.
  if (input.pixKeyType === 'CPF' && pixKey !== u.cpf) {
    throw new AppError(422, 'PIX_KEY_NOT_OWNER', 'A chave Pix precisa ser o CPF da sua conta.', [
      { path: 'pixKey', message: 'Use o CPF cadastrado na sua conta.' },
    ])
  }

  const cfg = await ctx.settings.get()
  if (input.amountCents < cfg.withdrawMinCents) {
    throw new AppError(422, 'WITHDRAW_BELOW_MINIMUM', 'Valor abaixo do mínimo para saque.')
  }

  try {
    const w = await db.transaction(async (tx) => {
      await tx.insert(cashWallets).values({ userId, balanceCents: 0 }).onConflictDoNothing()
      await tx.select({ u: cashWallets.userId }).from(cashWallets).where(eq(cashWallets.userId, userId)).for('update')
      const [{ s } = { s: '0' }] = await tx
        .select({ s: sql<string>`coalesce(sum(${withdrawals.amountCents}), 0)` })
        .from(withdrawals)
        .where(
          and(
            eq(withdrawals.userId, userId),
            inArray(withdrawals.status, ['PENDING', 'PAID']),
            gte(withdrawals.createdAt, new Date(Date.now() - DAY_MS)),
          ),
        )
      if (Number(s) + input.amountCents > cfg.withdrawDailyMaxCents) {
        throw new AppError(422, 'WITHDRAW_DAILY_LIMIT', 'Limite diário de saque atingido.')
      }
      const [created] = await tx
        .insert(withdrawals)
        .values({ userId, amountCents: input.amountCents, pixKeyType: input.pixKeyType, pixKey, idempotencyKey })
        .returning()
      await applyCashMovement(tx, {
        userId,
        amountCents: -input.amountCents,
        type: 'WITHDRAWAL',
        referenceType: 'withdrawal',
        referenceId: created!.id,
        reason: 'Saque solicitado (reserva)',
      })
      await audit(tx, {
        actorId: userId,
        action: 'WITHDRAWAL_REQUESTED',
        entity: 'withdrawal',
        entityId: created!.id,
        metadata: { amountCents: input.amountCents, pixKeyType: input.pixKeyType, pixKeyMasked: maskPixKey(input.pixKeyType, pixKey) },
        ip: meta.ip,
      })
      return created!
    })
    return { withdrawal: toWithdrawalView(w), replayed: false }
  } catch (err) {
    if (isUniqueViolation(err, 'withdrawals_user_idempotency_uq')) {
      const again = await replay()
      if (again) return again
    }
    throw err
  }
}

export async function listMyWithdrawals(db: DbOrTx, userId: string, p: Pagination) {
  const where = eq(withdrawals.userId, userId)
  const [rows, [{ total } = { total: 0 }]] = await Promise.all([
    db.select().from(withdrawals).where(where).orderBy(desc(withdrawals.createdAt), desc(withdrawals.id)).limit(p.pageSize).offset(offsetOf(p)),
    db.select({ total: count() }).from(withdrawals).where(where),
  ])
  return paginated(rows.map(toWithdrawalView), total, p)
}

// ---------- admin ----------

/** ADMIN vê a chave completa (precisa para pagar); SUPPORT vê mascarada. */
export async function listWithdrawalsAdmin(
  ctx: AppContext,
  role: Role,
  q: Pagination & { status?: 'PENDING' | 'PAID' | 'REJECTED' | undefined; userId?: string | undefined },
) {
  const conds: SQL[] = []
  if (q.status) conds.push(eq(withdrawals.status, q.status))
  if (q.userId) conds.push(eq(withdrawals.userId, q.userId))
  const where = conds.length ? and(...conds) : undefined
  const [rows, [{ total } = { total: 0 }]] = await Promise.all([
    ctx.db
      .select({ w: withdrawals, userName: users.name, userEmail: users.email })
      .from(withdrawals)
      .innerJoin(users, eq(users.id, withdrawals.userId))
      .where(where)
      .orderBy(desc(withdrawals.createdAt), desc(withdrawals.id))
      .limit(q.pageSize)
      .offset(offsetOf(q)),
    ctx.db.select({ total: count() }).from(withdrawals).where(where),
  ])
  return paginated(
    rows.map((r) => ({
      ...toWithdrawalView(r.w),
      userId: r.w.userId,
      userName: r.userName,
      userEmail: r.userEmail,
      decidedById: r.w.decidedById,
      ...(role === 'ADMIN' ? { pixKey: r.w.pixKey } : {}),
    })),
    total,
    q,
  )
}

/** Aprovar (PAID) ou recusar (REJECTED + estorno WITHDRAWAL_REVERSAL). Só PENDING; ADMIN não decide o próprio saque. */
export async function decideWithdrawal(
  ctx: AppContext,
  actor: AuthInfo,
  id: string,
  decision: { approve: true } | { approve: false; reason: string },
  meta: RequestMeta,
) {
  const w = await ctx.db.transaction(async (tx) => {
    const [cur] = await tx.select().from(withdrawals).where(eq(withdrawals.id, id)).for('update')
    if (!cur) throw notFound('Saque não encontrado.')
    if (cur.userId === actor.userId) throw forbidden('Você não pode decidir o próprio saque.', 'SELF_DECISION_FORBIDDEN')
    if (cur.status !== 'PENDING') throw conflict('Este saque já foi decidido.', 'WITHDRAWAL_ALREADY_DECIDED')
    const now = new Date()
    const [upd] = await tx
      .update(withdrawals)
      .set(
        decision.approve
          ? { status: 'PAID', decidedById: actor.userId, decidedAt: now }
          : { status: 'REJECTED', decidedById: actor.userId, decidedAt: now, rejectReason: decision.reason },
      )
      .where(eq(withdrawals.id, id))
      .returning()
    if (!decision.approve) {
      await applyCashMovement(tx, {
        userId: cur.userId,
        amountCents: cur.amountCents,
        type: 'WITHDRAWAL_REVERSAL',
        referenceType: 'withdrawal',
        referenceId: cur.id,
        reason: `Saque recusado: ${decision.reason}`,
        createdById: actor.userId,
      })
    }
    await audit(tx, {
      actorId: actor.userId,
      action: decision.approve ? 'WITHDRAWAL_APPROVED' : 'WITHDRAWAL_REJECTED',
      entity: 'withdrawal',
      entityId: id,
      metadata: {
        userId: cur.userId,
        amountCents: cur.amountCents,
        pixKeyMasked: maskPixKey(cur.pixKeyType, cur.pixKey),
        ...(decision.approve ? {} : { reason: decision.reason }),
      },
      ip: meta.ip,
    })
    return upd!
  })
  return { ...toWithdrawalView(w), userId: w.userId, cashBalanceCents: await getCashBalance(ctx.db, w.userId) }
}
