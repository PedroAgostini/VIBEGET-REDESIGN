/**
 * QA — D2 (vencedor sem cashback) e D3 (configurações pelo admin).
 */
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { auditLogs, gets, settings as settingsTable } from '../src/db/schema.js'
import { bearer, createLiveVibe, createTestApp, CSRF, nextCpf, userWithToken, type TestContext } from './helpers.js'
import { assertLedgerInvariant, balanceOf, confirmedGet, fund, get, send } from './qa-helpers.js'

let t: TestContext
let admin: Awaited<ReturnType<typeof userWithToken>>
beforeAll(async () => {
  t = await createTestApp()
  admin = await userWithToken(t, { role: 'ADMIN' })
})
afterAll(async () => {
  await assertLedgerInvariant(t)
  await t.close()
})

const A = () => bearer(admin.accessToken)
const close = (id: string) => send(t, 'POST', `/admin/vibes/${id}/close`, undefined, A())

describe('D2 — vencedor sem cashback', () => {
  it('vencedor com 3 Gets (inclusive com GetCoin) recebe 0; cada Get perdedor de outros recebe 40% do cash', async () => {
    const { vibe } = await createLiveVibe(t)
    const w = await userWithToken(t)
    const l1 = await userWithToken(t)
    const l2 = await userWithToken(t)
    await fund(t, w.id, 500)
    await confirmedGet(t, w.accessToken, vibe.id, { cashCents: 5000 })
    await confirmedGet(t, w.accessToken, vibe.id, { cashCents: 1000, getcoinCents: 500 })
    await confirmedGet(t, w.accessToken, vibe.id, { cashCents: 700 })
    await confirmedGet(t, l1.accessToken, vibe.id, { cashCents: 1000 })
    await confirmedGet(t, l1.accessToken, vibe.id, { cashCents: 2000 })
    await confirmedGet(t, l2.accessToken, vibe.id, { cashCents: 999 })
    const r = await close(vibe.id)
    expect(r.json().data.cashbackIssuedCents).toBe(400 + 800 + 399)
    expect(await balanceOf(t, w.id)).toBe(0)
    expect(await balanceOf(t, l1.id)).toBe(1200)
    expect(await balanceOf(t, l2.id)).toBe(399)
  })

  /**
   * [QA-18] Vários lançamentos do mesmo usuário na mesma transação (ex.: 2 cashbacks no settlement) recebem o
   * MESMO created_at (now() = início da transação) e ids UUIDv4 aleatórios. O extrato ordena por
   * (created_at DESC, id DESC), então a ordem entre eles é aleatória e o "saldo após" do topo pode não ser o saldo.
   */
  it('[QA-18] extrato: o lançamento mais recente (topo) fecha com o saldo atual', async () => {
    let wrong = 0
    for (let i = 0; i < 6; i++) {
      const { vibe } = await createLiveVibe(t)
      const w = await userWithToken(t)
      const l = await userWithToken(t)
      await confirmedGet(t, w.accessToken, vibe.id, { cashCents: 9000 })
      for (const c of [1000, 2000, 3000]) await confirmedGet(t, l.accessToken, vibe.id, { cashCents: c })
      await close(vibe.id)
      const wallet = (await get(t, '/me/wallet', l.accessToken)).json()
      if (wallet.data[0].balanceAfterCents !== wallet.balanceCents) wrong++
    }
    expect(wrong).toBe(0)
  })

  it('empate: o mais antigo vence e o outro (perdedor) recebe cashback; o vencedor não recebe pelos outros Gets', async () => {
    const { vibe } = await createLiveVibe(t)
    const a = await userWithToken(t)
    const b = await userWithToken(t)
    const aGet = await confirmedGet(t, a.accessToken, vibe.id, { cashCents: 1000 })
    await confirmedGet(t, a.accessToken, vibe.id, { cashCents: 600 })
    const bGet = await confirmedGet(t, b.accessToken, vibe.id, { cashCents: 1000 })
    await t.db.update(gets).set({ createdAt: new Date(Date.now() + 60_000) }).where(eq(gets.id, bGet))
    expect((await close(vibe.id)).json().data.winnerGetId).toBe(aGet)
    expect(await balanceOf(t, a.id)).toBe(0)
    expect(await balanceOf(t, b.id)).toBe(400)
  })
})

describe('D3 — /admin/settings', () => {
  it('USER e SUPPORT → 403 em GET e PATCH; sem token → 401', async () => {
    const u = await userWithToken(t)
    const s = await userWithToken(t, { role: 'SUPPORT' })
    for (const tok of [u.accessToken, s.accessToken]) {
      expect((await get(t, '/admin/settings', tok)).statusCode).toBe(403)
      expect((await send(t, 'PATCH', '/admin/settings', { welcomeBonusCents: 1 }, bearer(tok))).statusCode).toBe(403)
    }
    expect((await get(t, '/admin/settings')).statusCode).toBe(401)
  })

  it('GET devolve os 5 valores com os padrões do env', async () => {
    const res = await get(t, '/admin/settings', admin.accessToken)
    expect(res.json().data).toEqual({
      welcomeBonusCents: 0,
      referralBonusCents: 0,
      getCutoffSeconds: 60,
      paymentGraceSeconds: 40,
      defaultCashbackPercent: 40,
    })
  })

  it.each([
    ['margem > corte', { paymentGraceSeconds: 61 }],
    ['corte menor que a margem atual', { getCutoffSeconds: 30 }],
    ['bônus negativo', { welcomeBonusCents: -1 }],
    ['bônus acima do teto', { referralBonusCents: 100_001 }],
    ['fracionado', { welcomeBonusCents: 1.5 }],
    ['string', { getCutoffSeconds: '60' }],
    ['null', { defaultCashbackPercent: null }],
    ['cashback 101', { defaultCashbackPercent: 101 }],
    ['corte > 1 h', { getCutoffSeconds: 3601 }],
    ['campo extra', { jwtSecret: 'x' }],
    ['vazio', {}],
  ])('rejeita %s (400) e nada muda', async (_l, body) => {
    const before = (await get(t, '/admin/settings', admin.accessToken)).json().data
    const r = await send(t, 'PATCH', '/admin/settings', body, A())
    expect(r.statusCode, r.body).toBe(400)
    expect((await get(t, '/admin/settings', admin.accessToken)).json().data).toEqual(before)
  })

  it('PATCH válido: aplica na hora (cache invalidado), grava linha e audit SETTINGS_UPDATED com de → para; PATCH sem mudança não audita', async () => {
    const r = await send(t, 'PATCH', '/admin/settings', { getCutoffSeconds: 90, paymentGraceSeconds: 50 }, A())
    expect(r.statusCode, r.body).toBe(200)
    expect((await get(t, '/admin/settings', admin.accessToken)).json().data).toMatchObject({ getCutoffSeconds: 90, paymentGraceSeconds: 50 })
    const logs = await t.db.select().from(auditLogs).where(eq(auditLogs.action, 'SETTINGS_UPDATED'))
    const last = logs.at(-1)!
    expect(last.actorId).toBe(admin.id)
    expect(last.metadata).toEqual({ changes: { getCutoffSeconds: { from: 60, to: 90 }, paymentGraceSeconds: { from: 40, to: 50 } } })
    await send(t, 'PATCH', '/admin/settings', { getCutoffSeconds: 90 }, A())
    expect((await t.db.select().from(auditLogs).where(eq(auditLogs.action, 'SETTINGS_UPDATED'))).length).toBe(logs.length)
    await send(t, 'PATCH', '/admin/settings', { getCutoffSeconds: 60, paymentGraceSeconds: 40 }, A())
    const rows = await t.db.select().from(settingsTable).where(eq(settingsTable.key, 'getCutoffSeconds'))
    expect(rows[0]!.value).toBe(60)
  })

  it('PATCHes paralelos terminam num estado válido (margem <= corte)', async () => {
    await Promise.all([
      send(t, 'PATCH', '/admin/settings', { getCutoffSeconds: 100, paymentGraceSeconds: 100 }, A()),
      send(t, 'PATCH', '/admin/settings', { getCutoffSeconds: 20, paymentGraceSeconds: 10 }, A()),
    ])
    const s = (await get(t, '/admin/settings', admin.accessToken)).json().data
    expect(s.paymentGraceSeconds).toBeLessThanOrEqual(s.getCutoffSeconds)
    await send(t, 'PATCH', '/admin/settings', { getCutoffSeconds: 60, paymentGraceSeconds: 40 }, A())
  })

  it('valores usados de fato: bônus de boas-vindas no cadastro, indicação na verificação, cashback padrão em Vibe nova', async () => {
    expect((await send(t, 'PATCH', '/admin/settings', { welcomeBonusCents: 250, referralBonusCents: 125, defaultCashbackPercent: 25 }, A())).statusCode).toBe(200)
    try {
      const ra = await send(t, 'POST', '/auth/register', { name: 'Ana Bonus', email: `ab${Date.now()}@x.dev`, password: 'Senha-Forte-Bonus-1', acceptTerms: true }, CSRF)
      expect(ra.statusCode, ra.body).toBe(201)
      const a = ra.json()
      expect(await balanceOf(t, a.user.id)).toBe(250)
      const bEmail = `bb${Date.now()}@x.dev`
      const rb = await send(t, 'POST', '/auth/register', { name: 'Bia Indicada', email: bEmail, password: 'Senha-Forte-Bonus-2', cpf: nextCpf(), acceptTerms: true, referralCode: a.user.referralCode }, CSRF)
      expect(rb.statusCode).toBe(201)
      await send(t, 'POST', '/auth/verify-email', { token: t.mailer.last('EMAIL_VERIFY', bEmail)!.token })
      expect(await balanceOf(t, a.user.id)).toBe(375)
      const { product } = await createLiveVibe(t)
      const v = await send(t, 'POST', '/admin/vibes', {
        productId: product.id,
        slug: `d3-${Date.now()}`,
        minGetCents: 100,
        startsAt: new Date(Date.now() + 3600_000).toISOString(),
        endsAt: new Date(Date.now() + 7200_000).toISOString(),
      }, A())
      expect(v.json().data.cashbackPercent).toBe(25)
      const explicit = await send(t, 'POST', '/admin/vibes', {
        productId: product.id,
        slug: `d3e-${Date.now()}`,
        minGetCents: 100,
        cashbackPercent: 40,
        startsAt: new Date(Date.now() + 3600_000).toISOString(),
        endsAt: new Date(Date.now() + 7200_000).toISOString(),
      }, A())
      expect(explicit.json().data.cashbackPercent).toBe(40)
      // bônus 0 não gera lançamento
      await send(t, 'PATCH', '/admin/settings', { welcomeBonusCents: 0 }, A())
      const rc = await send(t, 'POST', '/auth/register', { name: 'Caio Zero', email: `cz${Date.now()}@x.dev`, password: 'Senha-Forte-Bonus-3', acceptTerms: true }, CSRF)
      expect((await get(t, '/me/wallet', rc.json().accessToken)).json().data).toEqual([])
    } finally {
      await send(t, 'PATCH', '/admin/settings', { welcomeBonusCents: 0, referralBonusCents: 0, defaultCashbackPercent: 40 }, A())
    }
  })

})
