import { and, eq, lte } from 'drizzle-orm'
import type { AppContext } from '../../context.js'
import type { Db, Tx } from '../../db/client.js'
import { getcoinLedger, getcoinPurchases, gets, marketListings, marketOrders, payments, vibes, type Get, type GetcoinPurchase, type Payment } from '../../db/schema.js'
import { audit } from '../../lib/audit.js'
import { randomToken } from '../../lib/crypto.js'
import { notFound } from '../../lib/errors.js'
import { applyWalletMovement } from '../wallet/service.js'
import { markSoldOutIfDone, releaseOrderQuantity, settlePaidOrder } from '../market/core.js'

export type PaymentOutcome = 'PAID' | 'FAILED'

/**
 * Provedor de pagamento MOCK. Mesma interface que um gateway real teria:
 * criar cobrança, cancelar cobrança pendente e estornar cobrança paga.
 * Com gateway real, cancel/refund devem sair por uma fila (outbox) a partir dos eventos
 * PROVIDER_CHARGE_CANCEL_REQUESTED / PROVIDER_REFUND_REQUESTED gravados no audit log na mesma transação.
 */
export const mockProvider = {
  createCharge(input: { amountCents: number; method: 'PIX' | 'CARD' }) {
    const externalId = `mock_${randomToken(16)}`
    const pixCopyPaste =
      input.method === 'PIX'
        ? `MOCKPIX|VIBEGET|${externalId}|${(input.amountCents / 100).toFixed(2)}|NAO-PAGAVEL`
        : null
    return { externalId, pixCopyPaste }
  },
  async cancelCharge(_externalId: string) {
    /* mock: nada a fazer */
  },
  async refundCharge(_externalId: string, _amountCents: number) {
    /* mock: nada a fazer */
  },
}

export const paymentPublicColumns = {
  id: payments.id,
  getId: payments.getId,
  provider: payments.provider,
  method: payments.method,
  status: payments.status,
  amountCents: payments.amountCents,
  pixCopyPaste: payments.pixCopyPaste,
  expiresAt: payments.expiresAt,
  paidAt: payments.paidAt,
  createdAt: payments.createdAt,
}

/**
 * Devolve o GetCoin usado num Get (se houver). Idempotente: se já existe REFUND para o Get, não repete.
 * Precisa de transação (e o chamador deve ter travado a linha do Get).
 */
export async function refundGetcoinOfGet(tx: Tx, get: Pick<Get, 'id' | 'userId' | 'getcoinCents'>, reason: string) {
  if (get.getcoinCents <= 0) return false
  const [already] = await tx
    .select({ id: getcoinLedger.id })
    .from(getcoinLedger)
    .where(
      and(
        eq(getcoinLedger.type, 'REFUND'),
        eq(getcoinLedger.referenceType, 'get'),
        eq(getcoinLedger.referenceId, get.id),
      ),
    )
    .limit(1)
  if (already) return false
  await applyWalletMovement(tx, {
    userId: get.userId,
    amountCents: get.getcoinCents,
    type: 'REFUND',
    referenceType: 'get',
    referenceId: get.id,
    reason,
  })
  return true
}

/** Marca uma cobrança pendente como FAILED e registra o pedido de cancelamento no provedor. */
export async function failPendingPayment(tx: Tx, payment: Payment, source: string) {
  await tx.update(payments).set({ status: 'FAILED' }).where(and(eq(payments.id, payment.id), eq(payments.status, 'PENDING')))
  await audit(tx, {
    action: 'PROVIDER_CHARGE_CANCEL_REQUESTED',
    entity: 'payment',
    entityId: payment.id,
    metadata: { externalId: payment.externalId, source },
  })
}

/**
 * Dinheiro recebido que não pode entrar na disputa (pagamento já FAILED/expirado, ou Vibe encerrada/cancelada):
 * registra como recebido e estornado, devolve o GetCoin (se ainda não foi) e grava o evento de estorno no provedor.
 */
async function refundLatePayment(tx: Tx, payment: Payment, get: Get, reason: string, source: string, paidAt = new Date()) {
  const [updated] = await tx
    .update(payments)
    .set({ status: 'REFUNDED', paidAt })
    .where(eq(payments.id, payment.id))
    .returning()
  await tx.update(gets).set({ status: 'REFUNDED' }).where(eq(gets.id, get.id))
  const getcoinRefunded = await refundGetcoinOfGet(tx, get, reason)
  await audit(tx, {
    action: 'PAYMENT_LATE_REFUND',
    entity: 'payment',
    entityId: payment.id,
    metadata: { source, getId: get.id, previousStatus: payment.status, reason, getcoinRefunded },
  })
  await audit(tx, {
    action: 'PROVIDER_REFUND_REQUESTED',
    entity: 'payment',
    entityId: payment.id,
    metadata: { externalId: payment.externalId, amountCents: payment.amountCents },
  })
  return updated!
}

/**
 * Aplica o resultado de um pagamento. Idempotente.
 * - PENDING + PAID com Vibe aberta -> PAID / Get CONFIRMED
 * - PENDING + PAID com Vibe encerrada/cancelada -> REFUNDED (estorno) / Get REFUNDED
 * - FAILED + PAID (pagou depois de expirar/falhar) -> REFUNDED (nunca descarta dinheiro em silêncio)
 * - PENDING + FAILED -> FAILED / Get FAILED / GetCoin devolvido
 * - demais combinações -> sem mudança
 * Ordem de locks (igual ao settlement): vibe -> payment -> get -> wallet.
 */
export async function applyPaymentOutcome(
  ctx: Pick<AppContext, 'db'>,
  paymentId: string,
  outcome: PaymentOutcome,
  source: 'webhook' | 'simulate' | 'expired',
  /** QA-21: horário do pagamento informado pelo provedor (já limitado por effectivePaidAt). */
  providerPaidAt?: Date,
) {
  const paidAt = providerPaidAt ?? new Date()
  const { db } = ctx
  const [target] = await db
    .select({ getId: payments.getId, purchaseId: payments.purchaseId, orderId: payments.orderId })
    .from(payments)
    .where(eq(payments.id, paymentId))
  if (!target) throw notFound('Pagamento não encontrado.')
  if (target.purchaseId) return applyPurchasePaymentOutcome(ctx, paymentId, outcome, source, paidAt)
  if (target.orderId) return applyOrderPaymentOutcome(ctx, paymentId, target.orderId, outcome, source, paidAt)

  const [ref] = await db
    .select({ vibeId: gets.vibeId })
    .from(payments)
    .innerJoin(gets, eq(gets.id, payments.getId))
    .where(eq(payments.id, paymentId))
  if (!ref) throw notFound('Pagamento não encontrado.')

  const result = await db.transaction(async (tx) => {
    const [vibe] = await tx.select().from(vibes).where(eq(vibes.id, ref.vibeId)).for('share')
    const [payment] = await tx.select().from(payments).where(eq(payments.id, paymentId)).for('update')
    if (!payment || !vibe || !payment.getId) throw notFound('Pagamento não encontrado.')
    const [get] = await tx.select().from(gets).where(eq(gets.id, payment.getId)).for('update')
    if (!get) throw notFound('Get não encontrado.')

    const unchanged = { payment, changed: false, providerAction: null as null | 'cancel' | 'refund' }

    if (outcome === 'PAID' && payment.status === 'FAILED') {
      const p = await refundLatePayment(tx, payment, get, 'Pagamento recebido após expirar/falhar', source, paidAt)
      return { payment: p, changed: true, providerAction: 'refund' as const }
    }
    if (payment.status !== 'PENDING') return unchanged

    if (outcome === 'PAID') {
      const vibeOpen = vibe.status === 'LIVE' && !vibe.settledAt
      if (!vibeOpen) {
        const p = await refundLatePayment(tx, payment, get, 'Pagamento recebido após o encerramento da Vibe', source, paidAt)
        return { payment: p, changed: true, providerAction: 'refund' as const }
      }
      // D1: o prazo do pagamento (TTL ou prazo final da Vibe) está em expires_at. PAID depois dele não conta,
      // mesmo que o job ainda não tenha marcado a cobrança como vencida: o resultado não depende do job.
      // QA-17: e nunca depois do fim da Vibe (mesmo se o endsAt mudou depois da criação do Get).
      if (paidAt > payment.expiresAt || paidAt >= vibe.endsAt) {
        const p = await refundLatePayment(tx, payment, get, 'Pagamento recebido após o prazo', source, paidAt)
        return { payment: p, changed: true, providerAction: 'refund' as const }
      }
      const [p] = await tx
        .update(payments)
        .set({ status: 'PAID', paidAt })
        .where(eq(payments.id, payment.id))
        .returning()
      await tx.update(gets).set({ status: 'CONFIRMED' }).where(eq(gets.id, get.id))
      await audit(tx, { action: 'PAYMENT_PAID', entity: 'payment', entityId: payment.id, metadata: { source, getId: get.id } })
      return { payment: p!, changed: true, providerAction: null }
    }

    // FAILED
    await failPendingPayment(tx, payment, source)
    await tx.update(gets).set({ status: 'FAILED' }).where(eq(gets.id, get.id))
    await refundGetcoinOfGet(tx, get, source === 'expired' ? 'Pagamento expirado' : 'Pagamento não aprovado')
    await audit(tx, { action: 'PAYMENT_FAILED', entity: 'payment', entityId: payment.id, metadata: { source, getId: get.id } })
    const [p] = await tx.select().from(payments).where(eq(payments.id, payment.id))
    return { payment: p!, changed: true, providerAction: 'cancel' as const }
  })

  // Chamada ao provedor só depois do commit (com gateway real: via outbox a partir do audit).
  if (result.providerAction === 'refund') await mockProvider.refundCharge(result.payment.externalId, result.payment.amountCents)
  if (result.providerAction === 'cancel') await mockProvider.cancelCharge(result.payment.externalId)
  return { payment: result.payment, changed: result.changed }
}

export async function findPaymentByExternalId(db: Db, externalId: string) {
  const [p] = await db.select({ id: payments.id }).from(payments).where(eq(payments.externalId, externalId))
  return p ?? null
}

/** Job: pagamentos pendentes vencidos viram FAILED e devolvem GetCoin. */
export async function expireStalePayments(ctx: Pick<AppContext, 'db'>, now = new Date()) {
  const stale = await ctx.db
    .select({ id: payments.id })
    .from(payments)
    .where(and(eq(payments.status, 'PENDING'), lte(payments.expiresAt, now)))
    .limit(500)
  for (const p of stale) await applyPaymentOutcome(ctx, p.id, 'FAILED', 'expired')
  return stale.length
}

/** Tolerância de relógio aceita para o paidAt informado pelo provedor no webhook (QA-21). */
export const WEBHOOK_CLOCK_SKEW_MS = 120_000

/**
 * QA-21: horário efetivo do pagamento. Usa o paidAt do provedor, mas nunca no futuro (limita à chegada)
 * e nunca mais que WEBHOOK_CLOCK_SKEW_MS antes da chegada. Sem paidAt: horário de chegada.
 */
export function effectivePaidAt(providerPaidAt: Date | undefined, arrivedAt: Date = new Date()): Date {
  if (!providerPaidAt) return arrivedAt
  const t = Math.min(providerPaidAt.getTime(), arrivedAt.getTime())
  return new Date(Math.max(t, arrivedAt.getTime() - WEBHOOK_CLOCK_SKEW_MS))
}

/** Dono do pagamento (para checagem de IDOR na simulação). */
export async function paymentOwner(db: Db, paymentId: string) {
  const [row] = await db
    .select({ getUser: gets.userId, purchaseUser: getcoinPurchases.userId, orderUser: marketOrders.buyerId })
    .from(payments)
    .leftJoin(gets, eq(gets.id, payments.getId))
    .leftJoin(getcoinPurchases, eq(getcoinPurchases.id, payments.purchaseId))
    .leftJoin(marketOrders, eq(marketOrders.id, payments.orderId))
    .where(eq(payments.id, paymentId))
  return row?.getUser ?? row?.purchaseUser ?? row?.orderUser ?? null
}

// ---------- D7: pagamentos de compra de GetCoin ----------

/** Credita o pacote comprado: PURCHASE (+ PURCHASE_BONUS se houver). Chamar só na transição para PAID. */
export async function creditPurchase(tx: Tx, purchase: GetcoinPurchase) {
  await applyWalletMovement(tx, {
    userId: purchase.userId,
    amountCents: purchase.getcoinsCents,
    type: 'PURCHASE',
    referenceType: 'purchase',
    referenceId: purchase.id,
    reason: `Compra do pacote ${purchase.packageName}`,
  })
  if (purchase.bonusCents > 0) {
    await applyWalletMovement(tx, {
      userId: purchase.userId,
      amountCents: purchase.bonusCents,
      type: 'PURCHASE_BONUS',
      referenceType: 'purchase',
      referenceId: purchase.id,
      reason: `Bônus do pacote ${purchase.packageName}`,
    })
  }
}

/**
 * Resultado de pagamento de compra. Idempotente; mesma política do Get:
 * PAID no prazo -> credita; PAID depois do prazo ou sobre FAILED -> REFUNDED + evento de estorno (QA-01);
 * FAILED -> compra FAILED. Ordem de locks: payment -> compra -> carteira.
 */
async function applyPurchasePaymentOutcome(
  ctx: Pick<AppContext, 'db'>,
  paymentId: string,
  outcome: PaymentOutcome,
  source: string,
  paidAt: Date,
) {
  const result = await ctx.db.transaction(async (tx) => {
    const [payment] = await tx.select().from(payments).where(eq(payments.id, paymentId)).for('update')
    if (!payment?.purchaseId) throw notFound('Pagamento não encontrado.')
    const [purchase] = await tx
      .select()
      .from(getcoinPurchases)
      .where(eq(getcoinPurchases.id, payment.purchaseId))
      .for('update')
    if (!purchase) throw notFound('Compra não encontrada.')

    const refundLate = async (reason: string) => {
      const [p] = await tx.update(payments).set({ status: 'REFUNDED', paidAt }).where(eq(payments.id, payment.id)).returning()
      await tx.update(getcoinPurchases).set({ status: 'REFUNDED' }).where(eq(getcoinPurchases.id, purchase.id))
      await audit(tx, {
        action: 'PAYMENT_LATE_REFUND',
        entity: 'payment',
        entityId: payment.id,
        metadata: { source, purchaseId: purchase.id, previousStatus: payment.status, reason },
      })
      await audit(tx, {
        action: 'PROVIDER_REFUND_REQUESTED',
        entity: 'payment',
        entityId: payment.id,
        metadata: { externalId: payment.externalId, amountCents: payment.amountCents },
      })
      return { payment: p!, changed: true, providerAction: 'refund' as const }
    }

    if (outcome === 'PAID' && payment.status === 'FAILED') return refundLate('Pagamento recebido após expirar/falhar')
    if (payment.status !== 'PENDING') return { payment, changed: false, providerAction: null }

    if (outcome === 'PAID') {
      if (paidAt > payment.expiresAt) return refundLate('Pagamento recebido após o prazo')
      const [p] = await tx.update(payments).set({ status: 'PAID', paidAt }).where(eq(payments.id, payment.id)).returning()
      await tx.update(getcoinPurchases).set({ status: 'PAID' }).where(eq(getcoinPurchases.id, purchase.id))
      await creditPurchase(tx, purchase)
      await audit(tx, {
        actorId: purchase.userId,
        action: 'PAYMENT_PAID',
        entity: 'payment',
        entityId: payment.id,
        metadata: { source, purchaseId: purchase.id, getcoinsCents: purchase.getcoinsCents, bonusCents: purchase.bonusCents },
      })
      return { payment: p!, changed: true, providerAction: null }
    }

    await failPendingPayment(tx, payment, source)
    await tx.update(getcoinPurchases).set({ status: 'FAILED' }).where(eq(getcoinPurchases.id, purchase.id))
    await audit(tx, { action: 'PAYMENT_FAILED', entity: 'payment', entityId: payment.id, metadata: { source, purchaseId: purchase.id } })
    const [p] = await tx.select().from(payments).where(eq(payments.id, payment.id))
    return { payment: p!, changed: true, providerAction: 'cancel' as const }
  })
  if (result.providerAction === 'refund') await mockProvider.refundCharge(result.payment.externalId, result.payment.amountCents)
  if (result.providerAction === 'cancel') await mockProvider.cancelCharge(result.payment.externalId)
  return { payment: result.payment, changed: result.changed }
}

// ---------- D12: pagamentos de pedido do marketplace ----------

/**
 * Resultado de pagamento de pedido. Idempotente (replay de webhook/simulate não credita duas vezes).
 * PAID no prazo -> liquida (GetCoin ao comprador; R$ ao vendedor menos taxa); PAID fora do prazo ou sobre FAILED
 * -> REFUNDED + evento de estorno no provedor (QA-01); FAILED/expirado -> quantidade volta ao anúncio (ou ao vendedor).
 * Ordem de locks: anúncio -> pagamento -> pedido -> carteiras.
 */
async function applyOrderPaymentOutcome(
  ctx: Pick<AppContext, 'db'>,
  paymentId: string,
  orderId: string,
  outcome: PaymentOutcome,
  source: string,
  paidAt: Date,
) {
  const [ref] = await ctx.db.select({ listingId: marketOrders.listingId }).from(marketOrders).where(eq(marketOrders.id, orderId))
  if (!ref) throw notFound('Pedido não encontrado.')
  const result = await ctx.db.transaction(async (tx) => {
    const [listing] = await tx.select().from(marketListings).where(eq(marketListings.id, ref.listingId)).for('update')
    const [payment] = await tx.select().from(payments).where(eq(payments.id, paymentId)).for('update')
    const [order] = await tx.select().from(marketOrders).where(eq(marketOrders.id, orderId)).for('update')
    if (!listing || !payment || !order) throw notFound('Pagamento não encontrado.')

    const refundLate = async (reason: string, releaseQty: boolean) => {
      const [p] = await tx.update(payments).set({ status: 'REFUNDED', paidAt }).where(eq(payments.id, payment.id)).returning()
      await tx.update(marketOrders).set({ status: 'REFUNDED' }).where(eq(marketOrders.id, order.id))
      const released = releaseQty ? await releaseOrderQuantity(tx, listing, order) : null
      await audit(tx, {
        action: 'PAYMENT_LATE_REFUND',
        entity: 'payment',
        entityId: payment.id,
        metadata: { source, orderId: order.id, previousStatus: payment.status, reason, released },
      })
      await audit(tx, {
        action: 'PROVIDER_REFUND_REQUESTED',
        entity: 'payment',
        entityId: payment.id,
        metadata: { externalId: payment.externalId, amountCents: payment.amountCents },
      })
      if (releaseQty) await markSoldOutIfDone(tx, listing.id)
      return { payment: p!, changed: true, providerAction: 'refund' as const }
    }

    // quantidade já voltou quando o pedido falhou; só estorna o dinheiro
    if (outcome === 'PAID' && payment.status === 'FAILED') return refundLate('Pagamento recebido após expirar/falhar', false)
    if (payment.status !== 'PENDING') return { payment, changed: false, providerAction: null }

    if (outcome === 'PAID') {
      if (paidAt > payment.expiresAt) return refundLate('Pagamento recebido após o prazo', true)
      const [p] = await tx.update(payments).set({ status: 'PAID', paidAt }).where(eq(payments.id, payment.id)).returning()
      await tx.update(marketOrders).set({ status: 'PAID' }).where(eq(marketOrders.id, order.id))
      await settlePaidOrder(tx, order, { buyerPaysWithBalance: false })
      await markSoldOutIfDone(tx, listing.id)
      await audit(tx, {
        actorId: order.buyerId,
        action: 'PAYMENT_PAID',
        entity: 'payment',
        entityId: payment.id,
        metadata: { source, orderId: order.id, feeCents: order.feeCents, sellerNetCents: order.sellerNetCents },
      })
      return { payment: p!, changed: true, providerAction: null }
    }

    await failPendingPayment(tx, payment, source)
    await tx.update(marketOrders).set({ status: 'FAILED' }).where(eq(marketOrders.id, order.id))
    const released = await releaseOrderQuantity(tx, listing, order)
    await audit(tx, { action: 'PAYMENT_FAILED', entity: 'payment', entityId: payment.id, metadata: { source, orderId: order.id, released } })
    const [p] = await tx.select().from(payments).where(eq(payments.id, payment.id))
    return { payment: p!, changed: true, providerAction: 'cancel' as const }
  })
  if (result.providerAction === 'refund') await mockProvider.refundCharge(result.payment.externalId, result.payment.amountCents)
  if (result.providerAction === 'cancel') await mockProvider.cancelCharge(result.payment.externalId)
  return { payment: result.payment, changed: result.changed }
}
