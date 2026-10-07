/**
 * Sanidade do builder para D11 (compra avulsa) e D12 (marketplace). A suíte completa é do QA.
 */
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { marketListings, marketOrders, payments, wallets } from '../src/db/schema.js'
import { applyCashMovement, cashInvariantOk } from '../src/modules/cash/service.js'
import { expireStalePayments } from '../src/modules/payments/service.js'
import { applyWalletMovement } from '../src/modules/wallet/service.js'
import { bearer, createTestApp, userWithToken, type TestContext } from './helpers.js'

let t: TestContext
let admin: Awaited<ReturnType<typeof userWithToken>>
beforeAll(async () => {
  t = await createTestApp()
  admin = await userWithToken(t, { role: 'ADMIN' })
})
afterAll(async () => {
  await t.close()
})

const api = (method: 'GET' | 'POST' | 'PATCH', url: string, token?: string, payload?: object, headers: Record<string, string> = {}) =>
  t.app.inject({ method, url: `/api/v1${url}`, headers: { ...(token ? bearer(token) : {}), ...headers }, ...(payload ? { payload } : {}) })
const giveGetcoin = (userId: string, cents: number) =>
  t.db.transaction((tx) => applyWalletMovement(tx, { userId, amountCents: cents, type: 'ADJUSTMENT', reason: 'teste' }))
const giveCash = (userId: string, cents: number) =>
  t.db.transaction((tx) => applyCashMovement(tx, { userId, amountCents: cents, type: 'ADJUSTMENT', reason: 'teste' }))
const gc = async (tok: string) => (await api('GET', '/me/wallet', tok)).json().balanceCents as number
const cash = async (tok: string) => (await api('GET', '/me/cash', tok)).json().data.balanceCents as number
let seq = 0
const order = (tok: string, listingId: string, getcoinsCents: number, method = 'PIX') =>
  api('POST', `/market/listings/${listingId}/orders`, tok, { getcoinsCents, method }, { 'idempotency-key': `mk-order-${++seq}-x` })

/** Conservação: Σ carteiras + custódia (remaining + pedidos pendentes) é constante. */
async function totalGetcoin() {
  const r = await t.db.execute(sql`SELECT
    (SELECT coalesce(sum(balance_cents),0) FROM wallets)
    + (SELECT coalesce(sum(remaining_cents),0) FROM market_listings)
    + (SELECT coalesce(sum(getcoins_cents),0) FROM market_orders WHERE status = 'PENDING_PAYMENT') AS n`)
  return Number((r as unknown as { rows: Array<{ n: unknown }> }).rows[0]!.n)
}

describe('D11 — compra avulsa', () => {
  it('preço = GetCoins × unitário, sem bônus; package como objeto "Avulso"; faixa e exclusividade validadas', async () => {
    const pub = await api('GET', '/getcoin-packages')
    expect(pub.json().custom).toEqual({ enabled: true, unitPriceCents: 100, minCents: 1000, maxCents: 100000 })
    const u = await userWithToken(t)
    const r = await api('POST', '/me/getcoin-purchases', u.accessToken, { customGetcoinsCents: 2500, method: 'PIX' }, { 'idempotency-key': 'd11-custom-01' })
    expect(r.statusCode).toBe(201)
    expect(r.json().data.package).toEqual({ id: null, name: 'Avulso', getcoinsCents: 2500, bonusCents: 0, priceCents: 2500 })
    await api('POST', `/payments/${r.json().data.payment.id}/simulate`, u.accessToken, { status: 'PAID' })
    expect(await gc(u.accessToken)).toBe(2500)
    const low = await api('POST', '/me/getcoin-purchases', u.accessToken, { customGetcoinsCents: 500, method: 'PIX' }, { 'idempotency-key': 'd11-custom-02' })
    expect(low.json().error.code).toBe('CUSTOM_AMOUNT_OUT_OF_RANGE')
    const both = await api('POST', '/me/getcoin-purchases', u.accessToken, { customGetcoinsCents: 2000, packageId: '00000000-0000-4000-8000-000000000000', method: 'PIX' }, { 'idempotency-key': 'd11-custom-03' })
    expect(both.statusCode).toBe(400)
    const frac = await api('POST', '/me/getcoin-purchases', u.accessToken, { customGetcoinsCents: 2050, method: 'PIX' }, { 'idempotency-key': 'd11-custom-04' })
    expect(frac.statusCode).toBe(400)
    expect((await api('PATCH', '/admin/settings/getcoin', admin.accessToken, { getcoinUnitPriceCents: 120 })).json().data.getcoinUnitPriceCents).toBe(120)
    const r2 = await api('POST', '/me/getcoin-purchases', u.accessToken, { customGetcoinsCents: 1000, method: 'PIX' }, { 'idempotency-key': 'd11-custom-05' })
    expect(r2.json().data.package.priceCents).toBe(1200)
    await api('PATCH', '/admin/settings/getcoin', admin.accessToken, { getcoinUnitPriceCents: 100 })
  })
})

describe('D12 — marketplace', () => {
  it('fluxo feliz: anúncio (custódia), config pública, compra PIX, taxa correta, vendedor líquido, venda parcial', async () => {
    const seller = await userWithToken(t, { name: 'Vendedora Silva' })
    const buyer = await userWithToken(t)
    await giveGetcoin(seller.id, 5000)
    const before = await totalGetcoin()

    const l = await api('POST', '/me/market/listings', seller.accessToken, { getcoinsCents: 3000, unitPriceCents: 95 })
    expect(l.statusCode).toBe(201)
    expect(l.json().data).toMatchObject({ totalCents: 3000, remainingCents: 3000, reservedCents: 0, soldCents: 0, status: 'ACTIVE' })
    expect(await gc(seller.accessToken)).toBe(2000)
    const lid = l.json().data.id

    const pub = await api('GET', '/market/listings?sort=price')
    expect(pub.json().config).toEqual({ enabled: true, feePercent: 10, minUnitPriceCents: 10, maxUnitPriceCents: 1000, minListingCents: 1000 })
    const item = pub.json().data.find((x: { id: string }) => x.id === lid)
    expect(item).toMatchObject({ seller: 'Vendedora S.', unitPriceCents: 95, remainingCents: 3000 })
    expect(pub.body).not.toContain(seller.email)

    const o = await order(buyer.accessToken, lid, 1100)
    expect(o.statusCode).toBe(201)
    // 11 GetCoins x R$ 0,95 = R$ 10,45; taxa floor(1045 x 10%) = 104
    expect(o.json().data).toMatchObject({ getcoinsCents: 1100, unitPriceCents: 95, totalPriceCents: 1045, status: 'PENDING_PAYMENT' })
    const mine = await api('GET', '/me/market/listings', seller.accessToken)
    expect(mine.json().data[0]).toMatchObject({ remainingCents: 1900, reservedCents: 1100, soldCents: 0 })

    const pay = await api('POST', `/payments/${o.json().data.payment.id}/simulate`, buyer.accessToken, { status: 'PAID' })
    expect(pay.json().data.status).toBe('PAID')
    // replay não credita duas vezes
    await api('POST', `/payments/${o.json().data.payment.id}/simulate`, buyer.accessToken, { status: 'PAID' })
    expect(await gc(buyer.accessToken)).toBe(1100)
    expect(await cash(seller.accessToken)).toBe(941)
    const sales = await api('GET', '/me/market/sales', seller.accessToken)
    expect(sales.json().data[0]).toMatchObject({ totalPriceCents: 1045, feeCents: 104, sellerNetCents: 941, status: 'PAID' })
    expect(sales.body).not.toContain(buyer.email)
    const tracked = await api('GET', `/me/market/orders/${o.json().data.id}`, buyer.accessToken)
    expect(tracked.json().data.status).toBe('PAID')
    expect((await api('GET', `/me/market/orders/${o.json().data.id}`, seller.accessToken)).statusCode).toBe(404)

    const again = await api('GET', '/me/market/listings', seller.accessToken)
    expect(again.json().data[0]).toMatchObject({ remainingCents: 1900, reservedCents: 0, soldCents: 1100, status: 'ACTIVE' })
    expect(await totalGetcoin()).toBe(before)
    expect(await cashInvariantOk(t.db, seller.id)).toBe(true)
    const dash = await api('GET', '/admin/dashboard', admin.accessToken)
    expect(dash.json().data.market.feeRevenueCents).toBeGreaterThanOrEqual(104)
  })

  it('não compra do próprio anúncio; não compra mais que o restante; BALANCE paga na hora e esgota', async () => {
    const seller = await userWithToken(t)
    const buyer = await userWithToken(t)
    await giveGetcoin(seller.id, 2000)
    await giveCash(buyer.id, 10_000)
    const lid = (await api('POST', '/me/market/listings', seller.accessToken, { getcoinsCents: 2000, unitPriceCents: 100 })).json().data.id
    const own = await order(seller.accessToken, lid, 1000)
    expect(own.statusCode).toBe(403)
    expect(own.json().error.code).toBe('OWN_LISTING')
    expect((await order(buyer.accessToken, lid, 2100)).json().error.code).toBe('LISTING_INSUFFICIENT')
    const b = await order(buyer.accessToken, lid, 2000, 'BALANCE')
    expect(b.statusCode).toBe(201)
    expect(b.json().data).toMatchObject({ status: 'PAID', payment: { status: 'PAID' }, balances: { cashBalanceCents: 8000, getcoinBalanceCents: 2000 } })
    const [l] = await t.db.select().from(marketListings).where(eq(marketListings.id, lid))
    expect(l).toMatchObject({ status: 'SOLD_OUT', remainingCents: 0 })
    expect(await cash(seller.accessToken)).toBe(1800)
    expect((await api('GET', '/market/listings')).json().data.some((x: { id: string }) => x.id === lid)).toBe(false)
    expect(await cashInvariantOk(t.db, buyer.id)).toBe(true)
  })

  it('cancelamento com pedido pendente: devolve o restante; pedido que falha depois volta ao vendedor', async () => {
    const seller = await userWithToken(t)
    const buyer = await userWithToken(t)
    await giveGetcoin(seller.id, 3000)
    const before = await totalGetcoin()
    const lid = (await api('POST', '/me/market/listings', seller.accessToken, { getcoinsCents: 3000, unitPriceCents: 50 })).json().data.id
    const o = await order(buyer.accessToken, lid, 1000)
    const c = await api('POST', `/me/market/listings/${lid}/cancel`, seller.accessToken)
    expect(c.json().data).toMatchObject({ status: 'CANCELLED', returnedCents: 2000, reservedCents: 1000 })
    expect(await gc(seller.accessToken)).toBe(2000)
    expect((await api('POST', `/me/market/listings/${lid}/cancel`, buyer.accessToken)).statusCode).toBe(404)
    await api('POST', `/payments/${o.json().data.payment.id}/simulate`, buyer.accessToken, { status: 'FAILED' })
    expect(await gc(seller.accessToken)).toBe(3000)
    expect(await totalGetcoin()).toBe(before)
  })

  it('expiração: o job libera a quantidade para o anúncio; PAID depois disso é estornado sem crédito', async () => {
    const seller = await userWithToken(t)
    const buyer = await userWithToken(t)
    await giveGetcoin(seller.id, 2000)
    const lid = (await api('POST', '/me/market/listings', seller.accessToken, { getcoinsCents: 2000, unitPriceCents: 100 })).json().data.id
    const o = await order(buyer.accessToken, lid, 1500)
    const pid = o.json().data.payment.id
    await t.db.update(payments).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(payments.id, pid))
    await expireStalePayments({ db: t.db })
    const [l] = await t.db.select().from(marketListings).where(eq(marketListings.id, lid))
    expect(l!.remainingCents).toBe(2000)
    const late = await api('POST', `/payments/${pid}/simulate`, buyer.accessToken, { status: 'PAID' })
    expect(late.json().data.status).toBe('REFUNDED')
    const [ord] = await t.db.select().from(marketOrders).where(eq(marketOrders.id, o.json().data.id))
    expect(ord!.status).toBe('REFUNDED')
    expect(await gc(buyer.accessToken)).toBe(0)
    const [w] = await t.db.select().from(wallets).where(eq(wallets.userId, seller.id))
    expect(w!.balanceCents).toBe(0)
  })

  it('pedidos no admin trazem nome e e-mail de comprador e vendedor', async () => {
    const seller = await userWithToken(t)
    const buyer = await userWithToken(t)
    await giveGetcoin(seller.id, 2000)
    const lid = (await api('POST', '/me/market/listings', seller.accessToken, { getcoinsCents: 2000, unitPriceCents: 100 })).json().data.id
    expect((await order(buyer.accessToken, lid, 1000)).statusCode).toBe(201)
    const rows = (await api('GET', `/admin/market/orders?listingId=${lid}`, admin.accessToken)).json().data
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ buyerId: buyer.id, sellerId: seller.id, buyerEmail: buyer.email, sellerEmail: seller.email })
    expect(rows[0].buyerName).toBeTruthy()
    expect(rows[0].sellerName).toBeTruthy()
  })

  it('limites de anúncio e admin cancela com audit', async () => {
    const seller = await userWithToken(t)
    await giveGetcoin(seller.id, 5000)
    expect((await api('POST', '/me/market/listings', seller.accessToken, { getcoinsCents: 500, unitPriceCents: 100 })).json().error.code).toBe('LISTING_BELOW_MINIMUM')
    expect((await api('POST', '/me/market/listings', seller.accessToken, { getcoinsCents: 1000, unitPriceCents: 5 })).json().error.code).toBe('UNIT_PRICE_OUT_OF_RANGE')
    expect((await api('POST', '/me/market/listings', seller.accessToken, { getcoinsCents: 9000, unitPriceCents: 100 })).json().error.code).toBe('INSUFFICIENT_GETCOIN')
    const lid = (await api('POST', '/me/market/listings', seller.accessToken, { getcoinsCents: 1000, unitPriceCents: 100 })).json().data.id
    const support = await userWithToken(t, { role: 'SUPPORT' })
    expect((await api('GET', '/admin/market/listings', support.accessToken)).statusCode).toBe(200)
    expect((await api('POST', `/admin/market/listings/${lid}/cancel`, support.accessToken)).statusCode).toBe(403)
    expect((await api('POST', `/admin/market/listings/${lid}/cancel`, admin.accessToken)).json().data.status).toBe('CANCELLED')
    const logs = await api('GET', `/admin/audit-logs?action=MARKET_LISTING_CANCELLED_BY_ADMIN&entityId=${lid}`, admin.accessToken)
    expect(logs.json().data).toHaveLength(1)
    expect((await api('GET', '/admin/market/orders', admin.accessToken)).json()).toHaveProperty('summary.feeRevenueCents')
    expect((await api('GET', '/admin/settings/market', admin.accessToken)).json().data).toEqual({
      marketFeePercent: 10,
      marketMinUnitPriceCents: 10,
      marketMaxUnitPriceCents: 1000,
      marketMinListingCents: 1000,
      marketEnabled: true,
      marketMaxPendingOrders: 2,
      marketOrderTtlMinutes: 10,
    })
  })

  it('QA-23: limite de pendentes (1 por anúncio, 2 no total), prazo de 10 min e esfriamento; QA-24: suspensão cancela anúncios', async () => {
    const buyer = await userWithToken(t)
    const ids: string[] = []
    for (let i = 0; i < 3; i++) {
      const s = await userWithToken(t)
      await giveGetcoin(s.id, 2000)
      ids.push((await api('POST', '/me/market/listings', s.accessToken, { getcoinsCents: 2000, unitPriceCents: 100 })).json().data.id)
    }
    const a = await order(buyer.accessToken, ids[0]!, 1000)
    expect(a.statusCode).toBe(201)
    const exp = new Date(a.json().data.payment.expiresAt).getTime() - new Date(a.json().data.createdAt).getTime()
    expect(Math.round(exp / 60_000)).toBe(10)
    expect((await order(buyer.accessToken, ids[0]!, 1000)).json().error.code).toBe('MARKET_TOO_MANY_PENDING')
    expect((await order(buyer.accessToken, ids[1]!, 1000)).statusCode).toBe(201)
    const third = await order(buyer.accessToken, ids[2]!, 1000)
    expect(third.statusCode).toBe(429)
    expect(third.json().error.code).toBe('MARKET_TOO_MANY_PENDING')

    // esfriamento: 3 pedidos falhos em 24 h
    const g = await userWithToken(t)
    for (let i = 0; i < 3; i++) {
      const r = await order(g.accessToken, ids[2]!, 100)
      await api('POST', `/payments/${r.json().data.payment.id}/simulate`, g.accessToken, { status: 'FAILED' })
    }
    const cool = await order(g.accessToken, ids[2]!, 100)
    expect(cool.statusCode).toBe(429)
    expect(cool.json().error.code).toBe('MARKET_COOLDOWN')

    // QA-24: suspender o vendedor cancela o anúncio e devolve o restante; some da vitrine
    const s = await userWithToken(t)
    await giveGetcoin(s.id, 1500)
    const lid = (await api('POST', '/me/market/listings', s.accessToken, { getcoinsCents: 1500, unitPriceCents: 100 })).json().data.id
    await api('PATCH', `/admin/users/${s.id}`, admin.accessToken, { status: 'SUSPENDED', reason: 'teste' })
    const [l] = await t.db.select().from(marketListings).where(eq(marketListings.id, lid))
    expect(l).toMatchObject({ status: 'CANCELLED', remainingCents: 0 })
    const [w] = await t.db.select().from(wallets).where(eq(wallets.userId, s.id))
    expect(w!.balanceCents).toBe(1500)
    const logs = await api('GET', `/admin/audit-logs?action=MARKET_LISTINGS_CANCELLED_ON_SUSPEND&entityId=${s.id}`, admin.accessToken)
    expect(logs.json().data).toHaveLength(1)
  })
})
