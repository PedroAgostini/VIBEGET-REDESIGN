/**
 * QA — pagamentos: webhook HMAC, replay, falha devolve GetCoin, expiração, simulação só fora de produção.
 */
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { auditLogs, payments, vibes } from '../src/db/schema.js'
import { expireStalePayments } from '../src/modules/payments/service.js'
import { settleVibe } from '../src/modules/vibes/settlement.js'
import { bearer, createLiveVibe, createUser, createTestApp, login, userWithToken, type TestContext } from './helpers.js'
import {
  assertLedgerInvariant,
  balanceOf,
  createProdApp,
  externalIdOfGet,
  fund,
  getRow,
  paymentOfGet,
  placeGet,
  send,
  sign,
  webhook,
} from './qa-helpers.js'

let t: TestContext
beforeAll(async () => {
  t = await createTestApp()
})
afterAll(async () => {
  await assertLedgerInvariant(t)
  await t.close()
})

async function pendingGet(getcoin = 0) {
  const { vibe } = await createLiveVibe(t)
  const u = await userWithToken(t)
  if (getcoin) await fund(t, u.id, getcoin)
  const res = await placeGet(t, u.accessToken, vibe.id, { cashCents: 500, getcoinCents: getcoin })
  expect(res.statusCode, res.body).toBe(201)
  const getId = res.json().data.get.id as string
  return { u, vibe, getId, paymentId: res.json().data.payment.id as string, externalId: await externalIdOfGet(t, getId) }
}

describe('POST /payments/webhook', () => {
  it('HMAC válido + PAID → 200 changed:true; Get CONFIRMED; pagamento PAID com paid_at; audit PAYMENT_PAID', async () => {
    const { getId, externalId, paymentId } = await pendingGet()
    const res = await webhook(t, externalId, 'PAID')
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toEqual({ received: true, changed: true })
    expect((await getRow(t, getId)).status).toBe('CONFIRMED')
    const p = await paymentOfGet(t, getId)
    expect(p.status).toBe('PAID')
    expect(p.paidAt).toBeInstanceOf(Date)
    const logs = await t.db.select().from(auditLogs).where(eq(auditLogs.entityId, paymentId))
    expect(logs.map((l) => l.action)).toContain('PAYMENT_PAID')
  })

  it('aceita prefixo "sha256=" e hex maiúsculo na assinatura', async () => {
    const { externalId } = await pendingGet()
    const raw = JSON.stringify({ externalId, status: 'PAID' })
    const res = await webhook(t, externalId, 'PAID', `sha256=${sign(t, raw).toUpperCase()}`)
    expect(res.statusCode).toBe(200)
  })

  it('assinatura ausente, vazia, errada, de outro segredo ou truncada → 401 e nada muda', async () => {
    const { getId, externalId } = await pendingGet()
    const raw = JSON.stringify({ externalId, status: 'PAID' })
    for (const sig of [null, '', 'abc', sign(t, raw, 'segredo-errado-segredo-errado-000'), sign(t, raw).slice(0, 32)]) {
      const res = await webhook(t, externalId, 'PAID', sig)
      expect(res.statusCode, String(sig)).toBe(401)
      expect(res.json().error.code).toBe('INVALID_SIGNATURE')
    }
    expect((await getRow(t, getId)).status).toBe('PENDING_PAYMENT')
  })

  it('corpo adulterado depois de assinado → 401 (assinatura é sobre o corpo cru)', async () => {
    const { externalId } = await pendingGet()
    const signedRaw = JSON.stringify({ externalId, status: 'FAILED' })
    const tampered = JSON.stringify({ externalId, status: 'PAID' })
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/v1/payments/webhook',
      headers: { 'content-type': 'application/json', 'x-signature': sign(t, signedRaw) },
      payload: tampered,
    })
    expect(res.statusCode).toBe(401)
  })

  it('mesmo JSON com espaçamento diferente exige nova assinatura (não re-serializa)', async () => {
    const { externalId } = await pendingGet()
    const compact = JSON.stringify({ externalId, status: 'PAID' })
    const spaced = JSON.stringify({ externalId, status: 'PAID' }, null, 2)
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/v1/payments/webhook',
      headers: { 'content-type': 'application/json', 'x-signature': sign(t, compact) },
      payload: spaced,
    })
    expect(res.statusCode).toBe(401)
  })

  it('replay do mesmo webhook → 200 changed:false, sem efeito duplo', async () => {
    const { externalId, getId } = await pendingGet()
    await webhook(t, externalId, 'PAID')
    const again = await webhook(t, externalId, 'PAID')
    expect(again.statusCode).toBe(200)
    expect(again.json().changed).toBe(false)
    // FAILED depois de PAID não desfaz
    const late = await webhook(t, externalId, 'FAILED')
    expect(late.json().changed).toBe(false)
    expect((await getRow(t, getId)).status).toBe('CONFIRMED')
  })

  it('replay de FAILED não devolve GetCoin duas vezes', async () => {
    const { u, externalId } = await pendingGet(300)
    expect(await balanceOf(t, u.id)).toBe(0)
    await webhook(t, externalId, 'FAILED')
    await webhook(t, externalId, 'FAILED')
    expect(await balanceOf(t, u.id)).toBe(300)
    await assertLedgerInvariant(t)
  })

  it('externalId desconhecido com assinatura válida → 404; corpo com campo extra → 400; JSON inválido → 400', async () => {
    expect((await webhook(t, 'mock_nao_existe', 'PAID')).statusCode).toBe(404)
    const raw = JSON.stringify({ externalId: 'x', status: 'PAID', amountCents: 1 })
    const extra = await t.app.inject({
      method: 'POST',
      url: '/api/v1/payments/webhook',
      headers: { 'content-type': 'application/json', 'x-signature': sign(t, raw) },
      payload: raw,
    })
    expect(extra.statusCode).toBe(400)
    const bad = await t.app.inject({
      method: 'POST',
      url: '/api/v1/payments/webhook',
      headers: { 'content-type': 'application/json', 'x-signature': sign(t, '{bad') },
      payload: '{bad',
    })
    expect(bad.statusCode).toBe(400)
  })
})

describe('falha, expiração e pagamento tardio', () => {
  it('pagamento FAILED devolve o GetCoin (REFUND) e marca Get FAILED', async () => {
    const { u, externalId, getId } = await pendingGet(250)
    expect(await balanceOf(t, u.id)).toBe(0)
    await webhook(t, externalId, 'FAILED')
    expect(await balanceOf(t, u.id)).toBe(250)
    expect((await getRow(t, getId)).status).toBe('FAILED')
    const w = await t.app.inject({ method: 'GET', url: '/api/v1/me/wallet', headers: bearer(u.accessToken) })
    expect(w.json().data[0]).toMatchObject({ type: 'REFUND', amountCents: 250, referenceId: getId })
  })

  it('job de expiração: pendente vencido vira FAILED e devolve GetCoin; não vencido fica', async () => {
    const a = await pendingGet(100)
    const b = await pendingGet(100)
    await t.db.update(payments).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(payments.id, a.paymentId))
    await expireStalePayments({ db: t.db })
    expect((await paymentOfGet(t, a.getId)).status).toBe('FAILED')
    expect(await balanceOf(t, a.u.id)).toBe(100)
    expect((await paymentOfGet(t, b.getId)).status).toBe('PENDING')
    expect(await balanceOf(t, b.u.id)).toBe(0)
  })

  it('PAID depois da Vibe encerrada (pendente ainda) → pagamento e Get REFUNDED, GetCoin devolvido, não conta na disputa', async () => {
    const { u, vibe, externalId, getId } = await pendingGet(200)
    // encerra "por fora" sem settlement para simular a janela
    await t.db.update(vibes).set({ status: 'CANCELLED' }).where(eq(vibes.id, vibe.id))
    const res = await webhook(t, externalId, 'PAID')
    expect(res.json().changed).toBe(true)
    expect((await getRow(t, getId)).status).toBe('REFUNDED')
    expect((await paymentOfGet(t, getId)).status).toBe('REFUNDED')
    expect(await balanceOf(t, u.id)).toBe(200)
  })

  /**
   * [QA-01] Pix pago DEPOIS de o pagamento ter sido marcado FAILED (expirou ou a Vibe encerrou e o settlement
   * falhou os pendentes). O gateway confirma o dinheiro, mas o webhook é ignorado (changed:false) e o
   * pagamento fica FAILED: o cliente paga e não recebe Get nem estorno. Esperado: registrar o dinheiro
   * recebido e marcar para estorno (REFUNDED) — ou ao menos não descartar em silêncio.
   */
  it('[QA-01] PAID que chega depois de o pagamento ter expirado/falhado não pode ser descartado em silêncio', async () => {
    const { vibe, externalId, getId } = await pendingGet()
    await settleVibe({ db: t.db }, vibe.id) // settlement falha o pendente
    expect((await paymentOfGet(t, getId)).status).toBe('FAILED')
    const res = await webhook(t, externalId, 'PAID')
    expect(res.statusCode).toBe(200)
    const p = await paymentOfGet(t, getId)
    expect(p.status).toBe('REFUNDED')
  })
})

describe('POST /payments/:id/simulate', () => {
  it('dono simula PAID; corpo inválido → 400; id não-uuid → 400', async () => {
    const { u, paymentId } = await pendingGet()
    expect((await send(t, 'POST', `/payments/${paymentId}/simulate`, { status: 'REFUNDED' }, bearer(u.accessToken))).statusCode).toBe(400)
    expect((await send(t, 'POST', `/payments/abc/simulate`, { status: 'PAID' }, bearer(u.accessToken))).statusCode).toBe(400)
    const ok = await send(t, 'POST', `/payments/${paymentId}/simulate`, { status: 'PAID' }, bearer(u.accessToken))
    expect(ok.statusCode).toBe(200)
    expect(ok.json()).toMatchObject({ data: { status: 'PAID' }, changed: true })
  })

  it('ADMIN pode simular pagamento de terceiros (só fora de produção)', async () => {
    const { paymentId } = await pendingGet()
    const admin = await userWithToken(t, { role: 'ADMIN' })
    expect((await send(t, 'POST', `/payments/${paymentId}/simulate`, { status: 'PAID' }, bearer(admin.accessToken))).statusCode).toBe(200)
  })

  it('em produção a rota NÃO existe (404) e o webhook continua funcionando', async () => {
    const p = await createProdApp()
    try {
      const u = await createUser(p)
      const { accessToken } = await login(p, u.email)
      const { vibe } = await createLiveVibe(p)
      const g = await placeGet(p, accessToken, vibe.id, { cashCents: 500 })
      expect(g.statusCode, g.body).toBe(201)
      const res = await send(p, 'POST', `/payments/${g.json().data.payment.id}/simulate`, { status: 'PAID' }, bearer(accessToken))
      expect(res.statusCode).toBe(404)
      expect(res.json().error.code).toBe('NOT_FOUND')
      const wh = await webhook(p, await externalIdOfGet(p, g.json().data.get.id), 'PAID')
      expect(wh.statusCode).toBe(200)
    } finally {
      await p.close()
    }
  })
})
