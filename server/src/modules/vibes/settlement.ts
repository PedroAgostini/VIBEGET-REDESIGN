import { and, asc, desc, eq, gt, inArray, lte } from 'drizzle-orm'
import { safeErrorForLog } from '../../lib/log-safety.js'
import type { AppContext } from '../../context.js'
import type { Tx } from '../../db/client.js'
import { gets, payments, users, vibes, wallets } from '../../db/schema.js'
import { audit } from '../../lib/audit.js'
import { AppError, notFound } from '../../lib/errors.js'
import { cashbackFor } from '../../lib/money.js'
import { failPendingPayment, refundGetcoinOfGet } from '../payments/service.js'
import { applyWalletMovement } from '../wallet/service.js'
import { applyCashMovement, lockCashWallets } from '../cash/service.js'

export interface SettlementResult {
  vibeId: string
  alreadySettled: boolean
  winnerGetId: string | null
  winnerUserId: string | null
  confirmedGets: number
  failedPendingGets: number
  cashbackIssuedCents: number
  settledAt: Date
}

interface ActorInfo {
  actorId?: string | null
  ip?: string | null
}

/**
 * Trava, de uma vez e em ordem de user_id, as carteiras de todos os usuários com Gets pendentes/confirmados
 * na Vibe. Com a mesma ordem global em settlement e cancelamento, encerramentos simultâneos de Vibes
 * diferentes com usuários em comum não entram em deadlock (QA-02).
 */
async function lockWalletsOfVibe(tx: Tx, vibeId: string) {
  const rows = await tx
    .selectDistinct({ userId: gets.userId })
    .from(gets)
    .where(and(eq(gets.vibeId, vibeId), inArray(gets.status, ['PENDING_PAYMENT', 'CONFIRMED'])))
  const ids = rows.map((r) => r.userId)
  if (ids.length === 0) return
  await tx
    .select({ userId: wallets.userId })
    .from(wallets)
    .where(inArray(wallets.userId, ids))
    .orderBy(asc(wallets.userId))
    .for('update')
  // D6: depois as carteiras em R$ (Gets pagos com saldo são estornados para o saldo no cancelamento).
  await lockCashWallets(tx, [...ids].sort())
}

/** Falha os Gets ainda pendentes de uma Vibe, pede o cancelamento da cobrança e devolve o GetCoin. */
async function failPendingGets(tx: Tx, vibeId: string, reason: string, source: string) {
  const pending = await tx
    .select()
    .from(gets)
    .where(and(eq(gets.vibeId, vibeId), eq(gets.status, 'PENDING_PAYMENT')))
    .orderBy(asc(gets.userId), asc(gets.id))
    .for('update')
  for (const g of pending) {
    const [p] = await tx.select().from(payments).where(eq(payments.getId, g.id)).for('update')
    // Se o cliente pagar depois disso, applyPaymentOutcome registra e estorna (QA-01).
    if (p && p.status === 'PENDING') await failPendingPayment(tx, p, source)
    await tx.update(gets).set({ status: 'FAILED' }).where(eq(gets.id, g.id))
    await refundGetcoinOfGet(tx, g, reason)
  }
  return pending.length
}

/**
 * Encerramento de uma Vibe (regra 6.5). Idempotente e atômico:
 * - trava a Vibe (FOR UPDATE); se já tem settled_at devolve o resultado anterior sem efeitos;
 * - Gets pendentes falham e devolvem GetCoin;
 * - vence o maior total confirmado (empate -> o mais antigo);
 * - cada Get perdedor recebe floor(cash * cashback% / 100) em GetCoin (CASHBACK);
 * - vencedor vira VIBER; Vibe vai para ENDED com winner_get_id e settled_at.
 * Reutilizável por job (settleDueVibes) e pela rota POST /admin/vibes/:id/close.
 */
export async function settleVibe(
  ctx: Pick<AppContext, 'db'>,
  vibeId: string,
  actor: ActorInfo = {},
): Promise<SettlementResult> {
  return ctx.db.transaction(async (tx) => {
    const [vibe] = await tx.select().from(vibes).where(eq(vibes.id, vibeId)).for('update')
    if (!vibe) throw notFound('Vibe não encontrada.')

    if (vibe.settledAt) {
      const [winner] = vibe.winnerGetId
        ? await tx.select({ userId: gets.userId }).from(gets).where(eq(gets.id, vibe.winnerGetId))
        : []
      const confirmed = await tx
        .select({ id: gets.id })
        .from(gets)
        .where(and(eq(gets.vibeId, vibeId), eq(gets.status, 'CONFIRMED')))
      return {
        vibeId,
        alreadySettled: true,
        winnerGetId: vibe.winnerGetId,
        winnerUserId: winner?.userId ?? null,
        confirmedGets: confirmed.length,
        failedPendingGets: 0,
        cashbackIssuedCents: 0,
        settledAt: vibe.settledAt,
      }
    }
    if (vibe.status !== 'LIVE') {
      throw new AppError(409, 'VIBE_NOT_CLOSABLE', 'Só é possível encerrar uma Vibe em andamento (LIVE).')
    }

    await lockWalletsOfVibe(tx, vibeId)
    const failedPendingGets = await failPendingGets(tx, vibeId, 'Vibe encerrada antes da confirmação do pagamento', 'settlement')

    const confirmed = await tx
      .select()
      .from(gets)
      .where(and(eq(gets.vibeId, vibeId), eq(gets.status, 'CONFIRMED')))
      .orderBy(desc(gets.totalCents), asc(gets.createdAt), asc(gets.id))
    const winner = confirmed[0] ?? null

    let cashbackIssuedCents = 0
    // Ordena por usuário para travar carteiras sempre na mesma ordem.
    // D2: o vencedor não recebe cashback em NENHUM Get dele nesta Vibe; perdedores recebem por Get.
    const losers = confirmed
      .filter((g) => !winner || g.userId !== winner.userId)
      .sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0))
    for (const g of losers) {
      const cb = cashbackFor(g.cashCents, vibe.cashbackPercent)
      if (cb <= 0) continue
      await applyWalletMovement(tx, {
        userId: g.userId,
        amountCents: cb,
        type: 'CASHBACK',
        referenceType: 'get',
        referenceId: g.id,
        reason: `Cashback de ${vibe.cashbackPercent}% da Vibe ${vibe.slug}`,
      })
      cashbackIssuedCents += cb
    }

    if (winner) {
      await tx.update(users).set({ level: 'VIBER' }).where(eq(users.id, winner.userId))
    }

    const settledAt = new Date()
    await tx
      .update(vibes)
      .set({ status: 'ENDED', winnerGetId: winner?.id ?? null, settledAt })
      .where(eq(vibes.id, vibeId))

    await audit(tx, {
      actorId: actor.actorId ?? null,
      action: 'VIBE_SETTLED',
      entity: 'vibe',
      entityId: vibeId,
      metadata: {
        winnerGetId: winner?.id ?? null,
        confirmedGets: confirmed.length,
        failedPendingGets,
        cashbackIssuedCents,
        trigger: actor.actorId ? 'admin' : 'job',
      },
      ip: actor.ip ?? null,
    })

    return {
      vibeId,
      alreadySettled: false,
      winnerGetId: winner?.id ?? null,
      winnerUserId: winner?.userId ?? null,
      confirmedGets: confirmed.length,
      failedPendingGets,
      cashbackIssuedCents,
      settledAt,
    }
  })
}

/**
 * Cancela uma Vibe (ADMIN). Gets pendentes falham; Gets confirmados são estornados (mock)
 * e todo GetCoin usado volta para a carteira. Não há cashback em cancelamento.
 */
export async function cancelVibe(tx: Tx, vibeId: string) {
  const [vibe] = await tx.select().from(vibes).where(eq(vibes.id, vibeId)).for('update')
  if (!vibe) throw notFound('Vibe não encontrada.')
  if (vibe.status === 'ENDED' || vibe.status === 'CANCELLED') {
    throw new AppError(409, 'VIBE_FINISHED', 'Esta Vibe já foi encerrada ou cancelada.')
  }
  await lockWalletsOfVibe(tx, vibeId)
  const failed = await failPendingGets(tx, vibeId, 'Vibe cancelada', 'vibe_cancelled')
  const confirmed = await tx
    .select()
    .from(gets)
    .where(and(eq(gets.vibeId, vibeId), eq(gets.status, 'CONFIRMED')))
    .orderBy(asc(gets.userId), asc(gets.id))
    .for('update')
  for (const g of confirmed) {
    const refunded = await tx
      .update(payments)
      .set({ status: 'REFUNDED' })
      .where(and(eq(payments.getId, g.id), eq(payments.status, 'PAID')))
      .returning({ id: payments.id, externalId: payments.externalId, amountCents: payments.amountCents, method: payments.method })
    for (const p of refunded) {
      if (p.method === 'BALANCE') {
        // D6: Get pago com saldo volta para o saldo (sem provedor).
        await applyCashMovement(tx, {
          userId: g.userId,
          amountCents: p.amountCents,
          type: 'REFUND',
          referenceType: 'get',
          referenceId: g.id,
          reason: 'Vibe cancelada',
        })
        continue
      }
      await audit(tx, {
        action: 'PROVIDER_REFUND_REQUESTED',
        entity: 'payment',
        entityId: p.id,
        metadata: { externalId: p.externalId, amountCents: p.amountCents, source: 'vibe_cancelled' },
      })
    }
    await tx.update(gets).set({ status: 'REFUNDED' }).where(eq(gets.id, g.id))
    await refundGetcoinOfGet(tx, g, 'Vibe cancelada')
  }
  await tx.update(vibes).set({ status: 'CANCELLED' }).where(eq(vibes.id, vibeId))
  return { failedPendingGets: failed, refundedGets: confirmed.length }
}

/** Job: encerra Vibes LIVE cujo prazo acabou. */
export async function settleDueVibes(ctx: Pick<AppContext, 'db' | 'log'>, now = new Date()) {
  const due = await ctx.db
    .select({ id: vibes.id })
    .from(vibes)
    .where(and(eq(vibes.status, 'LIVE'), lte(vibes.endsAt, now)))
  const results: SettlementResult[] = []
  for (const v of due) {
    try {
      results.push(await settleVibe(ctx, v.id))
    } catch (err) {
      ctx.log.error({ error: safeErrorForLog(err), vibeId: v.id }, 'falha ao encerrar Vibe')
    }
  }
  return results
}

/** Job: Vibes agendadas cujo início chegou passam a LIVE. */
export async function activateScheduledVibes(ctx: Pick<AppContext, 'db'>, now = new Date()) {
  const rows = await ctx.db
    .update(vibes)
    .set({ status: 'LIVE' })
    .where(and(eq(vibes.status, 'SCHEDULED'), lte(vibes.startsAt, now), gt(vibes.endsAt, now)))
    .returning({ id: vibes.id })
  return rows.length
}

