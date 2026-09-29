import { and, asc, count, eq } from 'drizzle-orm'
import type { Tx } from '../../db/client.js'
import { marketListings, marketOrders, type MarketListing, type MarketOrder } from '../../db/schema.js'
import { applyCashMovement } from '../cash/service.js'
import { applyWalletMovement } from '../wallet/service.js'

/**
 * D12 — regras de movimentação do marketplace (usadas por pedidos, pagamentos e job de expiração).
 * Ordem de locks do sistema: anúncio -> pagamento/pedido -> carteiras GetCoin (user_id) -> carteiras R$ (user_id).
 * Conservação: GetCoin em custódia = Σ remaining dos anúncios + Σ getcoins dos pedidos PENDING_PAYMENT.
 */

/** Taxa do marketplace: fee = floor(total × % / 100); líquido = total − fee. */
export function marketFee(totalPriceCents: number, feePercent: number) {
  const feeCents = Math.floor((totalPriceCents * feePercent) / 100)
  return { feeCents, sellerNetCents: totalPriceCents - feeCents }
}

/** Preço total do pedido: GetCoins inteiros × preço por GetCoin. */
export const orderTotal = (getcoinsCents: number, unitPriceCents: number) => (getcoinsCents / 100) * unitPriceCents

/**
 * Pedido pago (uma única vez, chamado só na transição para PAID):
 * comprador recebe GetCoin (MARKET_BUY); vendedor recebe o bruto (MARKETPLACE_SALE) e paga a taxa (MARKETPLACE_FEE).
 * Se o comprador pagou com saldo, o débito dele entra aqui também, respeitando a ordem de user_id nas carteiras R$.
 */
export async function settlePaidOrder(tx: Tx, order: MarketOrder, opts: { buyerPaysWithBalance: boolean }) {
  await applyWalletMovement(tx, {
    userId: order.buyerId,
    amountCents: order.getcoinsCents,
    type: 'MARKET_BUY',
    referenceType: 'market_order',
    referenceId: order.id,
    reason: 'Compra de GetCoin no marketplace',
  })
  const cashOps: Array<() => Promise<unknown>> = []
  const seller = async () => {
    await applyCashMovement(tx, {
      userId: order.sellerId,
      amountCents: order.totalPriceCents,
      type: 'MARKETPLACE_SALE',
      referenceType: 'market_order',
      referenceId: order.id,
      reason: 'Venda de GetCoin no marketplace',
    })
    if (order.feeCents > 0) {
      await applyCashMovement(tx, {
        userId: order.sellerId,
        amountCents: -order.feeCents,
        type: 'MARKETPLACE_FEE',
        referenceType: 'market_order',
        referenceId: order.id,
        reason: 'Taxa do marketplace',
      })
    }
  }
  const buyer = () =>
    applyCashMovement(tx, {
      userId: order.buyerId,
      amountCents: -order.totalPriceCents,
      type: 'GETCOIN_PURCHASE',
      referenceType: 'market_order',
      referenceId: order.id,
      reason: 'Compra de GetCoin no marketplace (saldo)',
    })
  if (opts.buyerPaysWithBalance) {
    // carteiras R$ em ordem de user_id
    if (order.buyerId < order.sellerId) cashOps.push(buyer, seller)
    else cashOps.push(seller, buyer)
  } else {
    cashOps.push(seller)
  }
  for (const op of cashOps) await op()
}

/**
 * Pedido não pago (FAILED/expirado/estornado antes de pagar): a quantidade reservada volta para o anúncio
 * se ele ainda estiver ACTIVE; se já foi cancelado (ou esgotado), volta para a carteira do vendedor.
 * `listing` precisa estar travado (FOR UPDATE) pelo chamador.
 */
export async function releaseOrderQuantity(tx: Tx, listing: MarketListing, order: MarketOrder) {
  if (listing.status === 'ACTIVE') {
    await tx
      .update(marketListings)
      .set({ remainingCents: listing.remainingCents + order.getcoinsCents })
      .where(eq(marketListings.id, listing.id))
    return 'listing' as const
  }
  await applyWalletMovement(tx, {
    userId: order.sellerId,
    amountCents: order.getcoinsCents,
    type: 'MARKET_ESCROW_RETURN',
    referenceType: 'market_listing',
    referenceId: listing.id,
    reason: 'Pedido não pago em anúncio encerrado',
  })
  return 'seller' as const
}

/** ACTIVE sem saldo restante e sem pedidos pendentes vira SOLD_OUT. */
export async function markSoldOutIfDone(tx: Tx, listingId: string) {
  const [l] = await tx.select().from(marketListings).where(eq(marketListings.id, listingId))
  if (!l || l.status !== 'ACTIVE' || l.remainingCents > 0) return
  const [{ n } = { n: 0 }] = await tx
    .select({ n: count() })
    .from(marketOrders)
    .where(and(eq(marketOrders.listingId, listingId), eq(marketOrders.status, 'PENDING_PAYMENT')))
  if (n === 0) await tx.update(marketListings).set({ status: 'SOLD_OUT' }).where(eq(marketListings.id, listingId))
}

/**
 * QA-24: cancela todos os anúncios ACTIVE de um vendedor (ex.: conta suspensa) e devolve o restante
 * (MARKET_ESCROW_RETURN). Pedidos pendentes seguem o fluxo normal (pagos liquidam; falhos voltam ao vendedor).
 * Chamar dentro da transação que suspende o usuário. Locks: anúncios em ordem de id -> carteira GetCoin do vendedor.
 */
export async function cancelSellerListings(tx: Tx, sellerId: string, reason: string) {
  const active = await tx
    .select()
    .from(marketListings)
    .where(and(eq(marketListings.sellerId, sellerId), eq(marketListings.status, 'ACTIVE')))
    .orderBy(asc(marketListings.id))
    .for('update')
  let returnedCents = 0
  for (const l of active) {
    await tx.update(marketListings).set({ status: 'CANCELLED', remainingCents: 0 }).where(eq(marketListings.id, l.id))
    if (l.remainingCents > 0) {
      await applyWalletMovement(tx, {
        userId: sellerId,
        amountCents: l.remainingCents,
        type: 'MARKET_ESCROW_RETURN',
        referenceType: 'market_listing',
        referenceId: l.id,
        reason,
      })
      returnedCents += l.remainingCents
    }
  }
  return { cancelled: active.map((l) => l.id), returnedCents }
}
