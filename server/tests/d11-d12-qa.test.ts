/**
 * QA — D11 (compra avulsa de GetCoin) e D12 (marketplace de GetCoin entre usuários).
 * Foco: conservação de GetCoin, taxa, concorrência, pagamento (PAID/FAILED/expiração/tardio/replay), IDOR, regras.
 */
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { auditLogs, marketListings, marketOrders, payments, users } from '../src/db/schema.js'
import { applyCashMovement } from '../src/modules/cash/service.js'
import { marketFee } from '../src/modules/market/core.js'
import { expireStalePayments } from '../src/modules/payments/service.js'
import { bearer, createTestApp, userWithToken, type TestContext } from './helpers.js'
import { assertLedgerInvariant, balanceOf, fund, get, send, webhook } from './qa-helpers.js'

let t: TestContext
let admin: Awaited<ReturnType<typeof userWithToken>>
beforeAll(async () => {
  t = await createTestApp()
  admin = await userWithToken(t, { role: 'ADMIN' })
})
afterAll(async () => {
  await assertLedgerInvariant(t)
  await assertCashInvariant()
  await t.close()
})

const rows = <T>(r: unknown) => (r as { rows: T[] }).rows
let k = 0
const key = () => `mkt-${Date.now()}-${++k}`

async function fundCash(userId: string, cents: number) {
  await t.db.transaction((tx) => applyCashMovement(tx, { userId, amountCents: cents, type: 'ADJUSTMENT', reason: 'QA' }))
}
async function cashOf(userId: string) {
  const r = rows<{ b: string | null }>(await t.db.execute(sql`SELECT balance_cents AS b FROM cash_wallets WHERE user_id = ${userId}`))
  return Number(r[0]?.b ?? 0)
}
/** Σ carteiras GetCoin + custódia (remaining + reservado em pedidos pendentes). */
async function totalGetcoin() {
  const r = rows<{ n: unknown }>(
    await t.db.execute(sql`SELECT
      (SELECT coalesce(sum(balance_cents),0) FROM wallets)
      + (SELECT coalesce(sum(remaining_cents),0) FROM market_listings)
      + (SELECT coalesce(sum(getcoins_cents),0) FROM market_orders WHERE status = 'PENDING_PAYMENT') AS n`),
  )
  return Number(r[0]!.n)
}
async function assertCashInvariant() {
  const bad = rows(
    await t.db.execute(sql`
      SELECT w.user_id FROM cash_wallets w LEFT JOIN cash_ledger l ON l.user_id = w.user_id
      GROUP BY w.user_id, w.balance_cents HAVING w.balance_cents <> coalesce(sum(l.amount_cents),0)`),
  )
  expect(bad, 'cash_ledger divergente').toEqual([])
  expect(rows(await t.db.execute(sql`SELECT user_id FROM cash_wallets WHERE balance_cents < 0`))).toEqual([])
}
async function assertAll(expectedTotal?: number) {
  await assertLedgerInvariant(t)
  await assertCashInvariant()
  if (expectedTotal !== undefined) expect(await totalGetcoin()).toBe(expectedTotal)
}

const listing = (tok: string, getcoinsCents: number, unitPriceCents: number) =>
  send(t, 'POST', '/me/market/listings', { getcoinsCents, unitPriceCents }, bearer(tok))
const order = (tok: string, listingId: string, getcoinsCents: number, method: 'PIX' | 'CARD' | 'BALANCE' = 'PIX', idem = key()) =>
  send(t, 'POST', `/market/listings/${listingId}/orders`, { getcoinsCents, method }, { ...bearer(tok), 'idempotency-key': idem })
const simulate = (tok: string, paymentId: string, status: 'PAID' | 'FAILED') =>
  send(t, 'POST', `/payments/${paymentId}/simulate`, { status }, bearer(tok))
async function extOfPayment(paymentId: string) {
  const [p] = await t.db.select().from(payments).where(eq(payments.id, paymentId))
  return p!.externalId
}
const listingRow = async (id: string) => (await t.db.select().from(marketListings).where(eq(marketListings.id, id)))[0]!
const orderRow = async (id: string) => (await t.db.select().from(marketOrders).where(eq(marketOrders.id, id)))[0]!
const setMarket = (body: object) => send(t, 'PATCH', '/admin/settings/market', body, bearer(admin.accessToken))

async function seller(getcoins = 10_000) {
  const s = await userWithToken(t, { name: 'Sofia Vendedora Ramos' })
  await fund(t, s.id, getcoins)
  return s
}

describe('taxa (unidade)', () => {
  it.each([
    [999, 10, 99, 900],
    [1000, 10, 100, 900],
    [1, 10, 0, 1],
    [999, 0, 0, 999],
    [999, 50, 499, 500],
    [12345, 7, 864, 11481],
  ])('total %i com %i%% → fee %i, líquido %i (fee + líquido = total)', (total, pct, fee, net) => {
    expect(marketFee(total, pct)).toEqual({ feeCents: fee, sellerNetCents: net })
    expect(fee + net).toBe(total)
  })
})

describe('anúncio', () => {
  it('custódia: GetCoin sai da carteira (MARKET_ESCROW); cancelar devolve o restante uma vez; total conservado', async () => {
    const s = await seller(5000)
    const before = await totalGetcoin()
    const l = await listing(s.accessToken, 3000, 95)
    expect(l.statusCode, l.body).toBe(201)
    expect(await balanceOf(t, s.id)).toBe(2000)
    await assertAll(before)
    const c1 = await send(t, 'POST', `/me/market/listings/${l.json().data.id}/cancel`, undefined, bearer(s.accessToken))
    expect(c1.statusCode).toBe(200)
    const c2 = await send(t, 'POST', `/me/market/listings/${l.json().data.id}/cancel`, undefined, bearer(s.accessToken))
    expect(c2.statusCode).toBe(409)
    expect(await balanceOf(t, s.id)).toBe(5000)
    await assertAll(before)
  })

  it.each([
    ['quantidade não inteira (150)', { getcoinsCents: 1050, unitPriceCents: 100 }, 400],
    ['quantidade zero', { getcoinsCents: 0, unitPriceCents: 100 }, 400],
    ['quantidade fracionada', { getcoinsCents: 1000.5, unitPriceCents: 100 }, 400],
    ['abaixo do mínimo de anúncio', { getcoinsCents: 900, unitPriceCents: 100 }, 422],
    ['preço abaixo da faixa', { getcoinsCents: 1000, unitPriceCents: 9 }, 422],
    ['preço acima da faixa', { getcoinsCents: 1000, unitPriceCents: 1001 }, 422],
    ['maior que o saldo', { getcoinsCents: 20_000, unitPriceCents: 100 }, 422],
    ['campo extra sellerId', { getcoinsCents: 1000, unitPriceCents: 100, sellerId: '00000000-0000-4000-8000-000000000000' }, 400],
  ])('rejeita %s', async (_l, body, code) => {
    const s = await seller(10_000)
    const r = await send(t, 'POST', '/me/market/listings', body, bearer(s.accessToken))
    expect(r.statusCode, r.body).toBe(code)
    expect(await balanceOf(t, s.id)).toBe(10_000)
  })

  it('vendedor com e-mail não verificado → 403; marketEnabled=false → 422', async () => {
    const u = await userWithToken(t, { verified: false })
    await fund(t, u.id, 5000)
    expect((await listing(u.accessToken, 1000, 100)).statusCode).toBe(403)
    const s = await seller()
    await setMarket({ marketEnabled: false })
    try {
      const r = await listing(s.accessToken, 1000, 100)
      expect(r.statusCode).toBe(422)
      expect(r.json().error.code).toBe('MARKET_DISABLED')
    } finally {
      await setMarket({ marketEnabled: true })
    }
  })

  it('lista pública: só nome público do vendedor; nunca id, e-mail ou nome completo; esconde anúncio sem saldo', async () => {
    const s = await seller()
    const l = await listing(s.accessToken, 1000, 100)
    const pub = await get(t, '/market/listings?sort=recent&pageSize=100')
    const item = pub.json().data.find((x: { id: string }) => x.id === l.json().data.id)
    expect(item.seller).toBe('Sofia R.')
    expect(pub.body).not.toContain(s.id)
    expect(pub.body).not.toContain(s.email)
    expect(pub.body).not.toContain('Vendedora')
    expect(Object.keys(item).sort()).toEqual(['createdAt', 'id', 'remainingCents', 'seller', 'totalCents', 'unitPriceCents'])
    const b = await userWithToken(t)
    await fundCash(b.id, 1000)
    await order(b.accessToken, l.json().data.id, 1000, 'BALANCE')
    const pub2 = await get(t, '/market/listings?sort=recent&pageSize=100')
    expect(pub2.json().data.find((x: { id: string }) => x.id === l.json().data.id)).toBeUndefined()
  })
})

describe('pedido — pagamento', () => {
  it('BALANCE: pago na hora; comprador recebe MARKET_BUY; vendedor recebe bruto − taxa; preço ímpar arredonda a taxa para baixo', async () => {
    const s = await seller()
    const b = await userWithToken(t)
    await fundCash(b.id, 5000)
    const before = await totalGetcoin()
    const l = await listing(s.accessToken, 3000, 333)
    const r = await order(b.accessToken, l.json().data.id, 300, 'BALANCE') // 3 GC × 333 = 999
    expect(r.statusCode, r.body).toBe(201)
    expect(r.json().data).toMatchObject({ status: 'PAID', totalPriceCents: 999, unitPriceCents: 333 })
    expect(await balanceOf(t, b.id)).toBe(300)
    expect(await cashOf(b.id)).toBe(5000 - 999)
    expect(await cashOf(s.id)).toBe(900) // 999 − floor(99,9)
    const o = await orderRow(r.json().data.id)
    expect(o.feeCents + o.sellerNetCents).toBe(o.totalPriceCents)
    const sales = await get(t, '/me/market/sales', s.accessToken)
    expect(sales.json().data[0]).toMatchObject({ feeCents: 99, sellerNetCents: 900 })
    expect(sales.body).not.toContain(b.id)
    await assertAll(before)
  })

  it.each([0, 50])('taxa configurada em %i%% é aplicada (e fica congelada no pedido)', async (pct) => {
    await setMarket({ marketFeePercent: pct })
    try {
      const s = await seller()
      const b = await userWithToken(t)
      const l = await listing(s.accessToken, 1000, 101)
      const r = await order(b.accessToken, l.json().data.id, 1000, 'PIX') // 1010
      await setMarket({ marketFeePercent: 10 }) // mudar depois não afeta o pedido
      await simulate(b.accessToken, r.json().data.payment.id, 'PAID')
      expect(await cashOf(s.id)).toBe(1010 - Math.floor((1010 * pct) / 100))
    } finally {
      await setMarket({ marketFeePercent: 10 })
    }
  })

  it('BALANCE insuficiente → 422 e nada muda (remaining, carteiras)', async () => {
    const s = await seller()
    const b = await userWithToken(t)
    await fundCash(b.id, 500)
    const l = await listing(s.accessToken, 2000, 100)
    const before = await totalGetcoin()
    const r = await order(b.accessToken, l.json().data.id, 1000, 'BALANCE')
    expect(r.statusCode).toBe(422)
    expect(r.json().error.code).toBe('INSUFFICIENT_BALANCE')
    expect((await listingRow(l.json().data.id)).remainingCents).toBe(2000)
    expect(await cashOf(b.id)).toBe(500)
    await assertAll(before)
  })

  it('PIX: reserva; PAID via webhook credita uma vez; replay do webhook e do simulate não credita de novo', async () => {
    const s = await seller()
    const b = await userWithToken(t)
    const l = await listing(s.accessToken, 3000, 100)
    const before = await totalGetcoin()
    const r = await order(b.accessToken, l.json().data.id, 2000, 'PIX')
    expect(r.statusCode, r.body).toBe(201)
    expect(r.json().data.status).toBe('PENDING_PAYMENT')
    expect(r.json().data.payment.pixCopyPaste).toBeTruthy()
    expect((await listingRow(l.json().data.id)).remainingCents).toBe(1000)
    await assertAll(before)
    const ext = await extOfPayment(r.json().data.payment.id)
    expect((await webhook(t, ext, 'PAID')).json().changed).toBe(true)
    expect((await webhook(t, ext, 'PAID')).json().changed).toBe(false)
    expect((await simulate(b.accessToken, r.json().data.payment.id, 'PAID')).json().changed).toBe(false)
    expect((await webhook(t, ext, 'FAILED')).json().changed).toBe(false)
    expect(await balanceOf(t, b.id)).toBe(2000)
    expect(await cashOf(s.id)).toBe(1800)
    expect((await orderRow(r.json().data.id)).status).toBe('PAID')
    await assertAll(before)
  })

  it('FAILED devolve a quantidade ao anúncio ativo; replay de FAILED não devolve de novo', async () => {
    const s = await seller()
    const b = await userWithToken(t)
    const l = await listing(s.accessToken, 3000, 100)
    const before = await totalGetcoin()
    const r = await order(b.accessToken, l.json().data.id, 2000, 'CARD')
    await simulate(b.accessToken, r.json().data.payment.id, 'FAILED')
    await simulate(b.accessToken, r.json().data.payment.id, 'FAILED')
    expect((await listingRow(l.json().data.id)).remainingCents).toBe(3000)
    expect((await orderRow(r.json().data.id)).status).toBe('FAILED')
    await assertAll(before)
  })

  it('expiração pelo job: FAILED e a quantidade volta; PAID depois disso é estornado sem devolver quantidade de novo', async () => {
    const s = await seller()
    const b = await userWithToken(t)
    const l = await listing(s.accessToken, 3000, 100)
    const before = await totalGetcoin()
    const r = await order(b.accessToken, l.json().data.id, 1000, 'PIX')
    await expireStalePayments({ db: t.db }, new Date(Date.now() + 31 * 60_000))
    expect((await orderRow(r.json().data.id)).status).toBe('FAILED')
    expect((await listingRow(l.json().data.id)).remainingCents).toBe(3000)
    await webhook(t, await extOfPayment(r.json().data.payment.id), 'PAID')
    expect((await orderRow(r.json().data.id)).status).toBe('REFUNDED')
    expect((await listingRow(l.json().data.id)).remainingCents).toBe(3000)
    expect(await balanceOf(t, b.id)).toBe(0)
    expect(await cashOf(s.id)).toBe(0)
    await assertAll(before)
  })

  it('PAID tardio (depois do expires_at, antes do job): REFUNDED, quantidade volta uma vez, sem GetCoin nem R$', async () => {
    const s = await seller()
    const b = await userWithToken(t)
    const l = await listing(s.accessToken, 3000, 100)
    const before = await totalGetcoin()
    const r = await order(b.accessToken, l.json().data.id, 1000, 'PIX')
    await t.db.update(payments).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(payments.id, r.json().data.payment.id))
    const ext = await extOfPayment(r.json().data.payment.id)
    await webhook(t, ext, 'PAID')
    await webhook(t, ext, 'PAID')
    expect((await orderRow(r.json().data.id)).status).toBe('REFUNDED')
    expect((await listingRow(l.json().data.id)).remainingCents).toBe(3000)
    expect(await balanceOf(t, b.id)).toBe(0)
    expect(await cashOf(s.id)).toBe(0)
    await assertAll(before)
  })
})

describe('concorrência e conservação', () => {
  it('8 compradores em paralelo querendo 10 GC cada num anúncio de 50 GC → exatamente 5 levam; remaining 0; SOLD_OUT', async () => {
    const s = await seller(5000)
    const l = await listing(s.accessToken, 5000, 100)
    const before = await totalGetcoin()
    const buyers = await Promise.all(Array.from({ length: 8 }, () => userWithToken(t)))
    for (const b of buyers) await fundCash(b.id, 1000)
    const rs = await Promise.all(buyers.map((b) => order(b.accessToken, l.json().data.id, 1000, 'BALANCE')))
    expect(rs.filter((r) => r.statusCode === 201)).toHaveLength(5)
    expect(rs.filter((r) => r.statusCode === 409)).toHaveLength(3)
    const row = await listingRow(l.json().data.id)
    expect(row.remainingCents).toBe(0)
    expect(row.status).toBe('SOLD_OUT')
    await assertAll(before)
  })

  it('PIX em paralelo nunca reserva além do remaining', async () => {
    const s = await seller(5000)
    const l = await listing(s.accessToken, 3000, 100)
    const buyers = await Promise.all(Array.from({ length: 6 }, () => userWithToken(t)))
    const rs = await Promise.all(buyers.map((b) => order(b.accessToken, l.json().data.id, 1000, 'PIX')))
    expect(rs.filter((r) => r.statusCode === 201)).toHaveLength(3)
    expect((await listingRow(l.json().data.id)).remainingCents).toBe(0)
  })

  it('cancelar com pedidos pendentes em paralelo com FAILED/PAID: nenhum GetCoin a mais ou a menos', async () => {
    const s = await seller(6000)
    const l = await listing(s.accessToken, 5000, 100)
    const before = await totalGetcoin()
    const bs = await Promise.all(Array.from({ length: 3 }, () => userWithToken(t)))
    const os = []
    for (const b of bs) os.push((await order(b.accessToken, l.json().data.id, 1000, 'PIX')).json().data)
    await Promise.all([
      send(t, 'POST', `/me/market/listings/${l.json().data.id}/cancel`, undefined, bearer(s.accessToken)),
      simulate(bs[0]!.accessToken, os[0].payment.id, 'FAILED'),
      simulate(bs[1]!.accessToken, os[1].payment.id, 'PAID'),
    ])
    // o 3º expira depois do cancelamento
    await expireStalePayments({ db: t.db }, new Date(Date.now() + 31 * 60_000))
    expect(await balanceOf(t, bs[1]!.id)).toBe(1000)
    expect(await balanceOf(t, s.id)).toBe(6000 - 1000) // tudo volta, menos o vendido
    expect(await cashOf(s.id)).toBe(900)
    const row = await listingRow(l.json().data.id)
    expect(row.status).toBe('CANCELLED')
    expect(row.remainingCents).toBe(0)
    await assertAll(before)
  })

  it('PAID depois do cancelamento: comprador recebe e vendedor recebe o R$ (pedido pendente continua válido)', async () => {
    const s = await seller(3000)
    const b = await userWithToken(t)
    const l = await listing(s.accessToken, 3000, 100)
    const before = await totalGetcoin()
    const o = (await order(b.accessToken, l.json().data.id, 1000, 'PIX')).json().data
    await send(t, 'POST', `/me/market/listings/${l.json().data.id}/cancel`, undefined, bearer(s.accessToken))
    expect(await balanceOf(t, s.id)).toBe(2000)
    await simulate(b.accessToken, o.payment.id, 'PAID')
    expect(await balanceOf(t, b.id)).toBe(1000)
    expect(await cashOf(s.id)).toBe(900)
    await assertAll(before)
  })
})

describe('regras do pedido', () => {
  it('comprar do próprio anúncio → 403 OWN_LISTING', async () => {
    const s = await seller()
    const l = await listing(s.accessToken, 1000, 100)
    const r = await order(s.accessToken, l.json().data.id, 1000)
    expect(r.statusCode).toBe(403)
    expect(r.json().error.code).toBe('OWN_LISTING')
  })

  it('anúncio cancelado/esgotado → 409; maior que o remaining → 409; inexistente → 404', async () => {
    const s = await seller()
    const b = await userWithToken(t)
    const l = await listing(s.accessToken, 1000, 100)
    expect((await order(b.accessToken, l.json().data.id, 2000)).statusCode).toBe(409)
    await send(t, 'POST', `/me/market/listings/${l.json().data.id}/cancel`, undefined, bearer(s.accessToken))
    expect((await order(b.accessToken, l.json().data.id, 1000)).statusCode).toBe(409)
    expect((await order(b.accessToken, '00000000-0000-4000-8000-000000000000', 1000)).statusCode).toBe(404)
  })

  it.each([
    ['zero', 0],
    ['não inteira', 150],
    ['fracionada', 100.5],
    ['negativa', -100],
  ])('quantidade %s → 400', async (_l, q) => {
    const s = await seller()
    const b = await userWithToken(t)
    const l = await listing(s.accessToken, 1000, 100)
    expect((await order(b.accessToken, l.json().data.id, q)).statusCode).toBe(400)
  })

  it('preço vem do anúncio: corpo com preço/total → 400; totalPriceCents sempre = qtd × unitário do anúncio', async () => {
    const s = await seller()
    const b = await userWithToken(t)
    const l = await listing(s.accessToken, 1000, 250)
    const bad = await send(t, 'POST', `/market/listings/${l.json().data.id}/orders`, { getcoinsCents: 1000, method: 'PIX', unitPriceCents: 1 }, { ...bearer(b.accessToken), 'idempotency-key': key() })
    expect(bad.statusCode).toBe(400)
    const ok = await order(b.accessToken, l.json().data.id, 1000)
    expect(ok.json().data.totalPriceCents).toBe(2500)
  })

  it('comprador não verificado → 403; suspenso → 401; vendedor suspenso → 409 LISTING_UNAVAILABLE', async () => {
    const s = await seller()
    const l = await listing(s.accessToken, 2000, 100)
    const nv = await userWithToken(t, { verified: false })
    expect((await order(nv.accessToken, l.json().data.id, 1000)).statusCode).toBe(403)
    const sus = await userWithToken(t)
    await t.db.update(users).set({ status: 'SUSPENDED' }).where(eq(users.id, sus.id))
    expect((await order(sus.accessToken, l.json().data.id, 1000)).statusCode).toBe(401)
    await t.db.update(users).set({ status: 'SUSPENDED' }).where(eq(users.id, s.id))
    const b = await userWithToken(t)
    const r = await order(b.accessToken, l.json().data.id, 1000)
    expect(r.statusCode).toBe(409)
    await t.db.update(users).set({ status: 'ACTIVE' }).where(eq(users.id, s.id))
  })

  it('marketEnabled=false bloqueia pedidos', async () => {
    const s = await seller()
    const b = await userWithToken(t)
    const l = await listing(s.accessToken, 1000, 100)
    await setMarket({ marketEnabled: false })
    try {
      expect((await order(b.accessToken, l.json().data.id, 1000)).json().error.code).toBe('MARKET_DISABLED')
    } finally {
      await setMarket({ marketEnabled: true })
    }
  })

  it('idempotência: mesma chave → 200 e o mesmo pedido (reserva uma vez); corpo diferente → 409; sem chave → 400', async () => {
    const s = await seller()
    const b = await userWithToken(t)
    const l = await listing(s.accessToken, 3000, 100)
    const idem = key()
    const a = await order(b.accessToken, l.json().data.id, 1000, 'PIX', idem)
    const again = await order(b.accessToken, l.json().data.id, 1000, 'PIX', idem)
    expect(a.statusCode).toBe(201)
    expect(again.statusCode).toBe(200)
    expect(again.json().data.id).toBe(a.json().data.id)
    expect((await listingRow(l.json().data.id)).remainingCents).toBe(2000)
    expect((await order(b.accessToken, l.json().data.id, 2000, 'PIX', idem)).statusCode).toBe(409)
    expect((await order(b.accessToken, l.json().data.id, 1000, 'CARD', idem)).statusCode).toBe(409)
    const nokey = await send(t, 'POST', `/market/listings/${l.json().data.id}/orders`, { getcoinsCents: 1000, method: 'PIX' }, bearer(b.accessToken))
    expect(nokey.statusCode).toBe(400)
  })

  it('IDOR: /me/market/orders/:id de outro → 404; simulate do pagamento de pedido alheio → 404 e nada muda', async () => {
    const s = await seller()
    const b = await userWithToken(t)
    const x = await userWithToken(t)
    const l = await listing(s.accessToken, 1000, 100)
    const o = (await order(b.accessToken, l.json().data.id, 1000)).json().data
    expect((await get(t, `/me/market/orders/${o.id}`, x.accessToken)).statusCode).toBe(404)
    expect((await get(t, `/me/market/orders/${o.id}`, s.accessToken)).statusCode).toBe(404) // vendedor também não
    expect((await get(t, `/me/market/orders/${o.id}`, b.accessToken)).statusCode).toBe(200)
    expect((await simulate(x.accessToken, o.payment.id, 'PAID')).statusCode).toBe(404)
    expect((await simulate(s.accessToken, o.payment.id, 'PAID')).statusCode).toBe(404)
    expect((await orderRow(o.id)).status).toBe('PENDING_PAYMENT')
    // cancelar anúncio alheio
    expect((await send(t, 'POST', `/me/market/listings/${l.json().data.id}/cancel`, undefined, bearer(x.accessToken))).statusCode).toBe(404)
  })
})

describe('D11 — compra avulsa', () => {
  const buy = (tok: string, body: object, idem = key()) => send(t, 'POST', '/me/getcoin-purchases', body, { ...bearer(tok), 'idempotency-key': idem })

  it('preço calculado pelo servidor; campo de preço no corpo → 400; crédito único com replay', async () => {
    const u = await userWithToken(t)
    expect((await buy(u.accessToken, { customGetcoinsCents: 2000, method: 'PIX', priceCents: 1 })).statusCode).toBe(400)
    const r = await buy(u.accessToken, { customGetcoinsCents: 2000, method: 'PIX' })
    expect(r.statusCode, r.body).toBe(201)
    expect(r.json().data.package).toMatchObject({ id: null, priceCents: 2000, bonusCents: 0 })
    const pid = r.json().data.payment.id
    await simulate(u.accessToken, pid, 'PAID')
    await simulate(u.accessToken, pid, 'PAID')
    await webhook(t, await extOfPayment(pid), 'PAID')
    expect(await balanceOf(t, u.id)).toBe(2000)
  })

  it('BALANCE: debita R$ = preço calculado e credita GetCoin uma vez', async () => {
    await send(t, 'PATCH', '/admin/settings/getcoin', { getcoinUnitPriceCents: 90 }, bearer(admin.accessToken))
    try {
      const u = await userWithToken(t)
      await fundCash(u.id, 5000)
      const idem = key()
      const r = await buy(u.accessToken, { customGetcoinsCents: 3000, method: 'BALANCE' }, idem)
      expect(r.statusCode, r.body).toBe(201)
      await buy(u.accessToken, { customGetcoinsCents: 3000, method: 'BALANCE' }, idem)
      expect(await cashOf(u.id)).toBe(5000 - 2700)
      expect(await balanceOf(t, u.id)).toBe(3000)
      expect((await buy(u.accessToken, { customGetcoinsCents: 4000, method: 'BALANCE' }, idem)).statusCode).toBe(409)
    } finally {
      await send(t, 'PATCH', '/admin/settings/getcoin', { getcoinUnitPriceCents: 100 }, bearer(admin.accessToken))
    }
  })

  it.each([
    ['abaixo do mínimo', { customGetcoinsCents: 900, method: 'PIX' }, 422],
    ['acima do máximo', { customGetcoinsCents: 100_100, method: 'PIX' }, 422],
    ['não inteira', { customGetcoinsCents: 1050, method: 'PIX' }, 400],
    ['nenhum dos dois', { method: 'PIX' }, 400],
    ['os dois', { customGetcoinsCents: 1000, packageId: '00000000-0000-4000-8000-000000000000', method: 'PIX' }, 400],
  ])('%s → %i', async (_l, body, code) => {
    const u = await userWithToken(t)
    expect((await buy(u.accessToken, body)).statusCode).toBe(code)
  })

  it('getcoinCustomEnabled=false → 422; pacotes continuam funcionando', async () => {
    await send(t, 'PATCH', '/admin/settings/getcoin', { getcoinCustomEnabled: false }, bearer(admin.accessToken))
    try {
      const u = await userWithToken(t)
      const r = await buy(u.accessToken, { customGetcoinsCents: 2000, method: 'PIX' })
      expect(r.statusCode).toBe(422)
      expect((await get(t, '/getcoin-packages')).json().custom.enabled).toBe(false)
    } finally {
      await send(t, 'PATCH', '/admin/settings/getcoin', { getcoinCustomEnabled: true }, bearer(admin.accessToken))
    }
  })
})

describe('admin', () => {
  it('RBAC: settings/getcoin e settings/market só ADMIN; listas para SUPPORT; cancelar só ADMIN', async () => {
    const u = await userWithToken(t)
    const sup = await userWithToken(t, { role: 'SUPPORT' })
    for (const url of ['/admin/settings/getcoin', '/admin/settings/market']) {
      for (const tok of [u.accessToken, sup.accessToken]) {
        expect((await get(t, url, tok)).statusCode, url).toBe(403)
        expect((await send(t, 'PATCH', url, {}, bearer(tok))).statusCode, url).toBe(403)
      }
    }
    for (const url of ['/admin/market/listings', '/admin/market/orders']) {
      expect((await get(t, url, u.accessToken)).statusCode).toBe(403)
      expect((await get(t, url, sup.accessToken)).statusCode).toBe(200)
    }
    const s = await seller()
    const l = await listing(s.accessToken, 1000, 100)
    expect((await send(t, 'POST', `/admin/market/listings/${l.json().data.id}/cancel`, undefined, bearer(sup.accessToken))).statusCode).toBe(403)
    const c = await send(t, 'POST', `/admin/market/listings/${l.json().data.id}/cancel`, undefined, bearer(admin.accessToken))
    expect(c.statusCode).toBe(200)
    expect(await balanceOf(t, s.id)).toBe(10_000)
    const logs = await t.db.select().from(auditLogs).where(eq(auditLogs.entityId, l.json().data.id))
    expect(logs.map((x) => x.action)).toContain('MARKET_LISTING_CANCELLED_BY_ADMIN')
  })

  it.each([
    ['/admin/settings/market', { marketFeePercent: 51 }],
    ['/admin/settings/market', { marketFeePercent: -1 }],
    ['/admin/settings/market', { marketMinUnitPriceCents: 0 }],
    ['/admin/settings/market', { marketMinUnitPriceCents: 500, marketMaxUnitPriceCents: 100 }],
    ['/admin/settings/market', { marketEnabled: 'sim' }],
    ['/admin/settings/market', { welcomeBonusCents: 1 }],
    ['/admin/settings/getcoin', { getcoinUnitPriceCents: 0 }],
    ['/admin/settings/getcoin', { getcoinCustomMinCents: 5000, getcoinCustomMaxCents: 1000 }],
    ['/admin/settings/getcoin', { getcoinCustomMinCents: 1050 }],
    ['/admin/settings/getcoin', { marketFeePercent: 5 }],
  ])('%s rejeita %j', async (url, body) => {
    const r = await send(t, 'PATCH', url, body, bearer(admin.accessToken))
    expect(r.statusCode, r.body).toBe(400)
  })

  it('/admin/settings continua com as 5 chaves da D3 e PATCH de chave de mercado nele → 400', async () => {
    const r = await get(t, '/admin/settings', admin.accessToken)
    expect(Object.keys(r.json().data).sort()).toEqual(
      ['defaultCashbackPercent', 'getCutoffSeconds', 'paymentGraceSeconds', 'referralBonusCents', 'welcomeBonusCents'].sort(),
    )
    expect((await send(t, 'PATCH', '/admin/settings', { marketFeePercent: 20 }, bearer(admin.accessToken))).statusCode).toBe(400)
  })

  it('PATCH de settings/market audita de → para', async () => {
    await setMarket({ marketFeePercent: 12 })
    await setMarket({ marketFeePercent: 10 })
    const logs = await get(t, '/admin/audit-logs?action=SETTINGS_UPDATED&pageSize=5', admin.accessToken)
    expect(JSON.stringify(logs.json().data)).toContain('marketFeePercent')
  })

  it('/admin/market/orders traz a receita de taxas e não expõe Idempotency-Key', async () => {
    const r = await get(t, '/admin/market/orders?pageSize=100', admin.accessToken)
    expect(r.json().summary.feeRevenueCents).toBeGreaterThan(0)
    expect(r.body).not.toMatch(/idempotencyKey|mkt-\d/)
  })
})

describe('conta', () => {
  it('export LGPD traz anúncios e pedidos; DELETE /me com anúncio ativo ou pedido pendente → 409 MARKET_OPEN', async () => {
    const s = await seller()
    const b = await userWithToken(t)
    const l = await listing(s.accessToken, 1000, 100)
    await order(b.accessToken, l.json().data.id, 1000, 'PIX')
    const ex = (await get(t, '/me/export', s.accessToken)).json()
    expect(JSON.stringify(ex.market)).toContain(l.json().data.id)
    expect((await send(t, 'DELETE', '/me', { password: s.password }, bearer(s.accessToken))).json().error.code).toBe('MARKET_OPEN')
    expect((await send(t, 'DELETE', '/me', { password: b.password }, bearer(b.accessToken))).json().error.code).toBe('MARKET_OPEN')
  })
})

/**
 * [QA-23] Reserva sem custo: qualquer usuário verificado cria pedidos PIX que nunca paga e prende 100% do
 * remaining de qualquer anúncio por PAYMENT_TTL_MINUTES (30 min), renovando a cada expiração. Não há limite
 * de pedidos pendentes por comprador nem por anúncio. Esperado: um teto de pedidos pendentes por comprador.
 */
describe('abuso', () => {
  it('[QA-23] um comprador sem dinheiro não deveria conseguir travar anúncios inteiros com pedidos PIX não pagos', async () => {
    const griefer = await userWithToken(t)
    const listings = []
    for (let i = 0; i < 4; i++) {
      const s = await seller()
      listings.push((await listing(s.accessToken, 5000, 100)).json().data.id)
    }
    let reserved = 0
    for (const id of listings) {
      const r = await order(griefer.accessToken, id, 5000, 'PIX')
      if (r.statusCode === 201) reserved++
    }
    expect(reserved).toBeLessThan(4)
  })
})

/**
 * [QA-24] Vendedor suspenso: o anúncio continua ACTIVE e aparece na lista pública, mas qualquer pedido
 * responde 409 LISTING_UNAVAILABLE (vitrine com oferta impossível de comprar); os GetCoins ficam em custódia até um
 * ADMIN cancelar manualmente. Esperado: anúncios de vendedor não ACTIVE não aparecem na lista pública.
 */
describe('vendedor suspenso', () => {
  it('[QA-24] anúncio de vendedor suspenso não deveria aparecer na lista pública', async () => {
    const s = await seller()
    const l = await listing(s.accessToken, 1000, 100)
    await send(t, 'PATCH', `/admin/users/${s.id}`, { status: 'SUSPENDED', reason: 'fraude' }, bearer(admin.accessToken))
    const pub = await get(t, '/market/listings?sort=recent&pageSize=100')
    expect(pub.json().data.find((x: { id: string }) => x.id === l.json().data.id)).toBeUndefined()
  })
})
