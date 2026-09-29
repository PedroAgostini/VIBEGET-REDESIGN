/**
 * Sanidade do builder para D6–D9 (seção 6.2). A suíte completa é do QA.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { loadEnv } from '../src/config/env.js'
import { createDb } from '../src/db/client.js'
import { MemoryMailer } from '../src/lib/mailer.js'
import { applyCashMovement, cashInvariantOk } from '../src/modules/cash/service.js'
import { bearer, createLiveVibe, createTestApp, userWithToken, type TestContext } from './helpers.js'

let t: TestContext
let admin: Awaited<ReturnType<typeof userWithToken>>

beforeAll(async () => {
  t = await createTestApp()
  admin = await userWithToken(t, { role: 'ADMIN' })
})
afterAll(async () => {
  await t.close()
})

const api = (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, token?: string, payload?: object, headers: Record<string, string> = {}) =>
  t.app.inject({ method, url: `/api/v1${url}`, headers: { ...(token ? bearer(token) : {}), ...headers }, ...(payload ? { payload } : {}) })

const fundCash = (userId: string, cents: number) =>
  t.db.transaction((tx) => applyCashMovement(tx, { userId, amountCents: cents, type: 'ADJUSTMENT', reason: 'teste' }))

async function makePackage(extra: object = {}) {
  const r = await api('POST', '/admin/getcoin-packages', admin.accessToken, { name: 'Pacote 10', getcoinsCents: 1000, bonusCents: 200, priceCents: 900, ...extra })
  expect(r.statusCode).toBe(201)
  return r.json().data as { id: string }
}

describe('D7 — pacotes e compra de GetCoin', () => {
  it('CRUD só ADMIN; público lista só ativos', async () => {
    const support = await userWithToken(t, { role: 'SUPPORT' })
    expect((await api('GET', '/admin/getcoin-packages', support.accessToken)).statusCode).toBe(403)
    const p = await makePackage()
    const off = await makePackage({ name: 'Inativo', active: false })
    const pub = await api('GET', '/getcoin-packages')
    const ids = pub.json().data.map((x: { id: string }) => x.id)
    expect(ids).toContain(p.id)
    expect(ids).not.toContain(off.id)
    expect((await api('PATCH', `/admin/getcoin-packages/${off.id}`, admin.accessToken, { sortOrder: 5 })).statusCode).toBe(200)
    expect((await api('DELETE', `/admin/getcoin-packages/${off.id}`, admin.accessToken)).statusCode).toBe(204)
  })

  it('PIX: pendente -> simulate PAID credita PURCHASE + PURCHASE_BONUS; outro usuário não vê (404); idempotente', async () => {
    const p = await makePackage()
    const u = await userWithToken(t)
    const h = { 'idempotency-key': 'buy-pix-0001' }
    const r = await api('POST', '/me/getcoin-purchases', u.accessToken, { packageId: p.id, method: 'PIX' }, h)
    expect(r.statusCode).toBe(201)
    const d = r.json().data
    expect(d).toMatchObject({ status: 'PENDING_PAYMENT', method: 'PIX', package: { getcoinsCents: 1000, bonusCents: 200, priceCents: 900 } })
    expect(d.payment.pixCopyPaste).toBeTruthy()
    expect((await api('POST', '/me/getcoin-purchases', u.accessToken, { packageId: p.id, method: 'PIX' }, h)).statusCode).toBe(200)

    const sim = await api('POST', `/payments/${d.payment.id}/simulate`, u.accessToken, { status: 'PAID' })
    expect(sim.statusCode).toBe(200)
    const after = await api('GET', `/me/getcoin-purchases/${d.id}`, u.accessToken)
    expect(after.json().data.status).toBe('PAID')
    const w = await api('GET', '/me/wallet', u.accessToken)
    expect(w.json().balanceCents).toBe(1200)
    expect(w.json().data.map((x: { type: string }) => x.type).sort()).toEqual(['PURCHASE', 'PURCHASE_BONUS'])
    // simular de novo não credita de novo
    await api('POST', `/payments/${d.payment.id}/simulate`, u.accessToken, { status: 'PAID' })
    expect((await api('GET', '/me/wallet', u.accessToken)).json().balanceCents).toBe(1200)

    const other = await userWithToken(t)
    expect((await api('GET', `/me/getcoin-purchases/${d.id}`, other.accessToken)).statusCode).toBe(404)
    expect((await api('GET', '/me/getcoin-purchases', u.accessToken)).json().meta.total).toBe(1)
  })

  it('BALANCE: PAID na hora, debita R$ e devolve saldos; sem saldo -> 422', async () => {
    const p = await makePackage()
    const u = await userWithToken(t)
    const poor = await api('POST', '/me/getcoin-purchases', u.accessToken, { packageId: p.id, method: 'BALANCE' }, { 'idempotency-key': 'buy-bal-0000' })
    expect(poor.statusCode).toBe(422)
    expect(poor.json().error.code).toBe('INSUFFICIENT_BALANCE')
    await fundCash(u.id, 2000)
    const r = await api('POST', '/me/getcoin-purchases', u.accessToken, { packageId: p.id, method: 'BALANCE' }, { 'idempotency-key': 'buy-bal-0001' })
    expect(r.statusCode).toBe(201)
    expect(r.json().data).toMatchObject({ status: 'PAID', balances: { cashBalanceCents: 1100, getcoinBalanceCents: 1200 } })
    expect(await cashInvariantOk(t.db, u.id)).toBe(true)
  })
})

describe('D6 — saldo, Get com saldo e saque', () => {
  it('Get BALANCE nasce CONFIRMED; cancelamento da Vibe devolve para o saldo', async () => {
    const u = await userWithToken(t)
    await fundCash(u.id, 1000)
    const { vibe } = await createLiveVibe(t)
    const g = await api('POST', `/vibes/${vibe.id}/gets`, u.accessToken, { cashCents: 600, method: 'BALANCE' }, { 'idempotency-key': 'get-bal-0001' })
    expect(g.statusCode).toBe(201)
    expect(g.json().data.get.status).toBe('CONFIRMED')
    expect(g.json().data.payment).toMatchObject({ status: 'PAID', method: 'BALANCE' })
    const cash = await api('GET', '/me/cash', u.accessToken)
    expect(cash.json().data.balanceCents).toBe(400)
    expect(cash.json().ledger.data[0]).toMatchObject({ type: 'GET_PAYMENT', amountCents: -600 })
    await api('PATCH', `/admin/vibes/${vibe.id}`, admin.accessToken, { status: 'CANCELLED' })
    expect((await api('GET', '/me/cash', u.accessToken)).json().data.balanceCents).toBe(1000)
    expect(await cashInvariantOk(t.db, u.id)).toBe(true)
  })

  it('saque: mínimo, reserva, aprovação e recusa com estorno; chave mascarada; ADMIN não decide o próprio', async () => {
    const u = await userWithToken(t)
    await fundCash(u.id, 5000)
    const h = (k: string) => ({ 'idempotency-key': k })
    const small = await api('POST', '/me/withdrawals', u.accessToken, { amountCents: 500, pixKeyType: 'EMAIL', pixKey: 'maria@exemplo.com' }, h('wd-small-01'))
    expect(small.json().error.code).toBe('WITHDRAW_BELOW_MINIMUM')
    const bad = await api('POST', '/me/withdrawals', u.accessToken, { amountCents: 1500, pixKeyType: 'CPF', pixKey: '123' }, h('wd-bad-0001'))
    expect(bad.statusCode).toBe(400)

    const a = await api('POST', '/me/withdrawals', u.accessToken, { amountCents: 1500, pixKeyType: 'EMAIL', pixKey: 'Maria@Exemplo.com' }, h('wd-ok-00001'))
    expect(a.statusCode).toBe(201)
    expect(a.json().data).toMatchObject({ status: 'PENDING', pixKeyMasked: 'm***@exemplo.com', cashBalanceCents: 3500 })
    expect(a.body).not.toContain('maria@exemplo.com')
    const b = await api('POST', '/me/withdrawals', u.accessToken, { amountCents: 2000, pixKeyType: 'PHONE', pixKey: '(11) 98765-4321' }, h('wd-ok-00002'))
    expect(b.statusCode).toBe(201)

    const support = await userWithToken(t, { role: 'SUPPORT' })
    const sl = await api('GET', `/admin/withdrawals?userId=${u.id}`, support.accessToken)
    expect(sl.json().data[0].pixKey).toBeUndefined()
    const al = await api('GET', `/admin/withdrawals?userId=${u.id}&status=PENDING`, admin.accessToken)
    expect(al.json().data.map((x: { pixKey: string }) => x.pixKey).sort()).toEqual(['+5511987654321', 'maria@exemplo.com'])

    const ap = await api('POST', `/admin/withdrawals/${a.json().data.id}/approve`, admin.accessToken)
    expect(ap.statusCode).toBe(200)
    expect(ap.json().data.status).toBe('PAID')
    expect((await api('POST', `/admin/withdrawals/${a.json().data.id}/approve`, admin.accessToken)).statusCode).toBe(409)
    expect((await api('POST', `/admin/withdrawals/${b.json().data.id}/reject`, admin.accessToken, { reason: 'x' })).statusCode).toBe(400)
    const rj = await api('POST', `/admin/withdrawals/${b.json().data.id}/reject`, admin.accessToken, { reason: 'Chave não confere' })
    expect(rj.json().data).toMatchObject({ status: 'REJECTED', rejectReason: 'Chave não confere', cashBalanceCents: 3500 })
    const mine = await api('GET', '/me/withdrawals', u.accessToken)
    expect(mine.json().meta.total).toBe(2)

    await fundCash(admin.id, 5000)
    const own = await api('POST', '/me/withdrawals', admin.accessToken, { amountCents: 1000, pixKeyType: 'EMAIL', pixKey: 'adm@exemplo.com' }, h('wd-adm-0001'))
    expect((await api('POST', `/admin/withdrawals/${own.json().data.id}/approve`, admin.accessToken)).statusCode).toBe(403)
    expect(await cashInvariantOk(t.db, u.id)).toBe(true)
  })

  it('limites de saque ficam em /admin/settings/withdrawals', async () => {
    const r = await api('GET', '/admin/settings/withdrawals', admin.accessToken)
    expect(r.json().data).toEqual({ withdrawMinCents: 1000, withdrawDailyMaxCents: 500000 })
    expect((await api('PATCH', '/admin/settings/withdrawals', admin.accessToken, { withdrawMinCents: 999999999 })).statusCode).toBe(400)
  })

  it('/me/cash mostra ao usuário o mínimo e quanto ainda pode sacar nas últimas 24 h', async () => {
    const u = await userWithToken(t)
    await fundCash(u.id, 5000)
    const before = (await api('GET', '/me/cash', u.accessToken)).json().data.withdraw
    expect(before).toEqual({ minCents: 1000, dailyMaxCents: 500000, usedLast24hCents: 0, availableCents: 500000 })
    const w = await api('POST', '/me/withdrawals', u.accessToken, { amountCents: 1500, pixKeyType: 'EMAIL', pixKey: 'lim@exemplo.com' }, { 'idempotency-key': 'wd-lim-0001' })
    expect(w.statusCode).toBe(201)
    const after = (await api('GET', '/me/cash', u.accessToken)).json().data.withdraw
    expect(after).toMatchObject({ usedLast24hCents: 1500, availableCents: 498500 })
    const rj = await api('POST', `/admin/withdrawals/${w.json().data.id}/reject`, admin.accessToken, { reason: 'Teste de limite' })
    expect(rj.statusCode).toBe(200)
    expect((await api('GET', '/me/cash', u.accessToken)).json().data.withdraw.usedLast24hCents).toBe(0)
  })
})

describe('D8 — endereço e CEP', () => {
  it('PUT /me/address valida e aparece em /auth/me', async () => {
    const u = await userWithToken(t)
    expect((await api('PUT', '/me/address', u.accessToken, { cep: '01001-000', street: 'Praça da Sé', number: '', district: 'Sé', city: 'São Paulo', state: 'SP' })).statusCode).toBe(400)
    expect((await api('PUT', '/me/address', u.accessToken, { cep: '01001-000', street: 'Praça da Sé', number: '1', district: 'Sé', city: 'São Paulo', state: 'XX' })).statusCode).toBe(400)
    const ok = await api('PUT', '/me/address', u.accessToken, { cep: '01001-000', street: 'Praça da Sé', number: '100', complement: 'lado ímpar', district: 'Sé', city: 'São Paulo', state: 'sp' })
    expect(ok.statusCode).toBe(200)
    const me = await api('GET', '/auth/me', u.accessToken)
    expect(me.json().user.address).toEqual({ cep: '01001000', street: 'Praça da Sé', number: '100', complement: 'lado ímpar', district: 'Sé', city: 'São Paulo', state: 'SP' })
  })

  it('GET /cep/:cep usa ViaCEP, cai para BrasilAPI, 404 para inexistente e cacheia', async () => {
    const calls: string[] = []
    const fakeFetch = async (url: string) => {
      calls.push(url)
      if (url.includes('viacep') && url.includes('01001000')) {
        return { ok: true, status: 200, json: async () => ({ cep: '01001-000', logradouro: 'Praça da Sé', bairro: 'Sé', localidade: 'São Paulo', uf: 'SP' }) }
      }
      if (url.includes('viacep') && url.includes('99999999')) return { ok: true, status: 200, json: async () => ({ erro: true }) }
      if (url.includes('viacep')) throw new Error('fora do ar')
      return { ok: true, status: 200, json: async () => ({ cep: '20040020', street: 'Rua X', neighborhood: 'Centro', city: 'Rio de Janeiro', state: 'RJ' }) }
    }
    const h = await createDb({ pgliteDataDir: null })
    await h.migrate()
    const app = await buildApp({ db: h.db, env: loadEnv({ NODE_ENV: 'test' }), mailer: new MemoryMailer(), logger: false, rateLimit: false, fetch: fakeFetch })
    try {
      const a = await app.inject({ method: 'GET', url: '/api/v1/cep/01001-000' })
      expect(a.json().data).toEqual({ cep: '01001000', street: 'Praça da Sé', district: 'Sé', city: 'São Paulo', state: 'SP' })
      await app.inject({ method: 'GET', url: '/api/v1/cep/01001000' })
      expect(calls.filter((c) => c.includes('01001000'))).toHaveLength(1)
      expect((await app.inject({ method: 'GET', url: '/api/v1/cep/99999999' })).statusCode).toBe(404)
      const fb = await app.inject({ method: 'GET', url: '/api/v1/cep/20040020' })
      expect(fb.json().data.city).toBe('Rio de Janeiro')
      expect((await app.inject({ method: 'GET', url: '/api/v1/cep/123' })).statusCode).toBe(400)
    } finally {
      await app.close()
      await h.close()
    }
  })
})

describe('D9 — Meus Gets', () => {
  it('summary, leading, isLeading e dashboard ampliado (sem dados de outros usuários)', async () => {
    const me = await userWithToken(t)
    const rival = await userWithToken(t, { name: 'Rival Secreto' })
    const { vibe: v1 } = await createLiveVibe(t)
    const { vibe: v2 } = await createLiveVibe(t)
    await fundCash(me.id, 10_000)
    await fundCash(rival.id, 10_000)
    const give = (tok: string, vid: string, cash: number, key: string) =>
      api('POST', `/vibes/${vid}/gets`, tok, { cashCents: cash, method: 'BALANCE' }, { 'idempotency-key': key })
    await give(me.accessToken, v1.id, 2000, 'd9-me-v1-01')
    await give(rival.accessToken, v1.id, 1000, 'd9-rv-v1-01')
    await give(me.accessToken, v2.id, 500, 'd9-me-v2-01')
    await give(rival.accessToken, v2.id, 900, 'd9-rv-v2-01')

    const s = await api('GET', '/me/gets/summary', me.accessToken)
    expect(s.json().data).toEqual({ participated: 2, active: 2, won: 0, lost: 0, leading: 1 })
    const l = await api('GET', '/me/gets/leading', me.accessToken)
    expect(l.json().data).toHaveLength(1)
    expect(l.json().data[0]).toMatchObject({ vibe: { id: v1.id }, myTopGet: { totalCents: 2000 }, participants: 2 })
    expect(l.json().data[0].vibe.getsCloseAt).toBeTruthy()
    expect(l.body).not.toContain('Rival')
    const list = await api('GET', '/me/gets', me.accessToken)
    const byVibe = Object.fromEntries(list.json().data.map((g: { vibeId: string; isLeading: boolean }) => [g.vibeId, g.isLeading]))
    expect(byVibe).toEqual({ [v1.id]: true, [v2.id]: false })
    expect(list.json().data[0].vibeStatus).toBe('LIVE')

    await api('POST', `/admin/vibes/${v1.id}/close`, admin.accessToken)
    await api('POST', `/admin/vibes/${v2.id}/close`, admin.accessToken)
    const s2 = await api('GET', '/me/gets/summary', me.accessToken)
    expect(s2.json().data).toEqual({ participated: 2, active: 0, won: 1, lost: 1, leading: 0 })
    const dash = await api('GET', '/me/dashboard', me.accessToken)
    expect(dash.json().data).toMatchObject({ cashBalanceCents: 7500, getsSummary: { won: 1 }, referralCode: expect.any(String) })
  })
})
