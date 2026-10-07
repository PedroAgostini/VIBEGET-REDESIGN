/**
 * QA — D4: cupons (admin, resgate atômico, resposta genérica, cadastro com cupom).
 */
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { coupons, getcoinLedger, users } from '../src/db/schema.js'
import { bearer, createTestApp, createUser, CSRF, login, userWithToken, type TestContext } from './helpers.js'
import { assertLedgerInvariant, balanceOf, get, send } from './qa-helpers.js'

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

let n = 0
const code = (p = 'QA') => `${p}${Date.now().toString(36).toUpperCase()}${++n}`
async function mkCoupon(o: Record<string, unknown> = {}) {
  const r = await send(t, 'POST', '/admin/coupons', { code: code(), amountCents: 500, ...o }, bearer(admin.accessToken))
  expect(r.statusCode, r.body).toBe(201)
  return r.json().data as { id: string; code: string }
}
const redeem = (token: string, c: unknown) => send(t, 'POST', '/me/coupons/redeem', { code: c }, bearer(token))

describe('resgate', () => {
  it('válido: credita COUPON no livro-razão, devolve saldo, case-insensitive e com espaços', async () => {
    const c = await mkCoupon({ amountCents: 750 })
    const u = await userWithToken(t)
    const r = await redeem(u.accessToken, `  ${c.code.toLowerCase()} `)
    expect(r.statusCode, r.body).toBe(200)
    expect(r.json().data).toEqual({ amountCents: 750, balanceCents: 750 })
    const [l] = await t.db.select().from(getcoinLedger).where(and(eq(getcoinLedger.userId, u.id), eq(getcoinLedger.type, 'COUPON')))
    expect(l).toMatchObject({ amountCents: 750, referenceType: 'coupon', referenceId: c.id })
  })

  it('todas as falhas dão a MESMA resposta (status + corpo): inexistente, inativo, não iniciado, expirado, esgotado, já usado, conta não nova, formato inválido', async () => {
    const u = await userWithToken(t)
    const other = await userWithToken(t)
    const inactive = await mkCoupon({ active: false })
    const future = await mkCoupon({ startsAt: new Date(Date.now() + 3600_000).toISOString() })
    const expired = await mkCoupon()
    await t.db.update(coupons).set({ startsAt: new Date(Date.now() - 7200_000), endsAt: new Date(Date.now() - 1000) }).where(eq(coupons.id, expired.id))
    const exhausted = await mkCoupon({ maxRedemptions: 1 })
    expect((await redeem(other.accessToken, exhausted.code)).statusCode).toBe(200)
    const used = await mkCoupon()
    expect((await redeem(u.accessToken, used.code)).statusCode).toBe(200)
    const newOnly = await mkCoupon({ newAccountsOnly: true })

    const bodies = new Set<string>()
    for (const c of ['NAOEXISTE123', inactive.code, future.code, expired.code, exhausted.code, used.code, newOnly.code, 'a b', '!!', '']) {
      const r = await redeem(u.accessToken, c)
      expect(r.statusCode, c).toBe(422)
      bodies.add(r.body)
    }
    expect(bodies.size).toBe(1)
    expect([...bodies][0]).toBe(JSON.stringify({ error: { code: 'COUPON_UNAVAILABLE', message: 'Cupom inválido ou indisponível.' } }))
    expect(await balanceOf(t, u.id)).toBe(500)
  })

  it('tempo de resposta não separa "inexistente" de "existe mas indisponível" de forma evidente', async () => {
    const u = await userWithToken(t)
    const exhausted = await mkCoupon({ maxRedemptions: 1 })
    await redeem((await userWithToken(t)).accessToken, exhausted.code)
    const time = async (c: string) => {
      const t0 = performance.now()
      for (let i = 0; i < 5; i++) await redeem(u.accessToken, c)
      return (performance.now() - t0) / 5
    }
    const a = await time('NAOEXISTE999')
    const b = await time(exhausted.code)
    expect(Math.abs(a - b)).toBeLessThan(25)
  })

  it('motivo real vai só para o audit (COUPON_REDEEM_FAILED)', async () => {
    const u = await userWithToken(t)
    await redeem(u.accessToken, 'NAOEXISTE777')
    const logs = await get(t, `/admin/audit-logs?action=COUPON_REDEEM_FAILED&actorId=${u.id}`, admin.accessToken)
    expect(logs.json().data[0].metadata).toEqual({ reason: 'not_found' })
  })

  it('limite total sob corrida: 10 usuários em paralelo num cupom de 3 → exatamente 3 resgates', async () => {
    const c = await mkCoupon({ maxRedemptions: 3, amountCents: 100 })
    const us = await Promise.all(Array.from({ length: 10 }, () => userWithToken(t)))
    const rs = await Promise.all(us.map((u) => redeem(u.accessToken, c.code)))
    expect(rs.filter((r) => r.statusCode === 200)).toHaveLength(3)
    expect(rs.filter((r) => r.statusCode === 422)).toHaveLength(7)
    const [row] = await t.db.select().from(coupons).where(eq(coupons.id, c.id))
    expect(row!.redemptionsCount).toBe(3)
  })

  it('limite por usuário sob corrida: 5 paralelos do mesmo usuário → 1 (limite 1) e 2 (limite 2)', async () => {
    for (const [limit, expected] of [[1, 1], [2, 2]] as const) {
      const c = await mkCoupon({ perUserLimit: limit, amountCents: 100 })
      const u = await userWithToken(t)
      const rs = await Promise.all(Array.from({ length: 5 }, () => redeem(u.accessToken, c.code)))
      expect(rs.filter((r) => r.statusCode === 200)).toHaveLength(expected)
      expect(await balanceOf(t, u.id)).toBe(100 * expected)
    }
  })

  it('"só contas novas": conta criada antes do cupom é recusada; conta criada depois aceita', async () => {
    const old = await userWithToken(t)
    await t.db.update(users).set({ createdAt: new Date(Date.now() - 60_000) }).where(eq(users.id, old.id))
    const c = await mkCoupon({ newAccountsOnly: true })
    expect((await redeem(old.accessToken, c.code)).statusCode).toBe(422)
    const fresh = await userWithToken(t)
    expect((await redeem(fresh.accessToken, c.code)).statusCode).toBe(200)
  })

  it('validade: startsAt futuro → indisponível; ao chegar a data → disponível', async () => {
    const c = await mkCoupon({ startsAt: new Date(Date.now() + 3600_000).toISOString() })
    const u = await userWithToken(t)
    expect((await redeem(u.accessToken, c.code)).statusCode).toBe(422)
    await t.db.update(coupons).set({ startsAt: new Date(Date.now() - 1000) }).where(eq(coupons.id, c.id))
    expect((await redeem(u.accessToken, c.code)).statusCode).toBe(200)
  })

  it('exige login; campo extra/tipo errado → 400', async () => {
    expect((await send(t, 'POST', '/me/coupons/redeem', { code: 'X' })).statusCode).toBe(401)
    const u = await userWithToken(t)
    expect((await send(t, 'POST', '/me/coupons/redeem', { code: 'ABC', amountCents: 999 }, bearer(u.accessToken))).statusCode).toBe(400)
    expect((await send(t, 'POST', '/me/coupons/redeem', { code: 123 }, bearer(u.accessToken))).statusCode).toBe(400)
  })

  it('rate limit: 10 por 15 min por IP; o 11º → 429', async () => {
    const r = await createTestApp({ rateLimit: true })
    try {
      const u = await userWithToken(r)
      const codes: number[] = []
      for (let i = 0; i < 11; i++) codes.push((await send(r, 'POST', '/me/coupons/redeem', { code: `NAO${i}XX` }, bearer(u.accessToken))).statusCode)
      expect(codes.slice(0, 10).every((c) => c === 422)).toBe(true)
      expect(codes[10]).toBe(429)
    } finally {
      await r.close()
    }
  })
})

describe('cupom no cadastro', () => {
  const reg = (couponCode?: unknown) =>
    send(t, 'POST', '/auth/register', {
      name: 'Cadastro Cupom',
      email: `cc${Date.now()}${++n}@x.dev`,
      password: 'Senha-Forte-Cupom-9',
      acceptTerms: true,
      ...(couponCode !== undefined ? { couponCode } : {}),
    }, CSRF)

  it('válido → 201 couponApplied:true e saldo; inválido/esgotado → 201 couponApplied:false; sem cupom → campo ausente', async () => {
    const c = await mkCoupon({ amountCents: 300, newAccountsOnly: true })
    const ok = await reg(c.code.toLowerCase())
    expect(ok.statusCode, ok.body).toBe(201)
    expect(ok.json().couponApplied).toBe(true)
    expect(await balanceOf(t, ok.json().user.id)).toBe(300)
    const bad = await reg('NAOEXISTE')
    expect(bad.statusCode).toBe(201)
    expect(bad.json().couponApplied).toBe(false)
    const weird = await reg('x'.repeat(64))
    expect(weird.statusCode).toBe(201)
    expect(weird.json().couponApplied).toBe(false)
    const none = await reg()
    expect(none.json().couponApplied).toBeUndefined()
    expect((await reg(12345)).statusCode).toBe(400)
  })
})

describe('admin de cupons', () => {
  it('RBAC: USER 403 em tudo; SUPPORT lê (lista e resgates), não cria/edita', async () => {
    const c = await mkCoupon()
    const u = await userWithToken(t)
    const s = await userWithToken(t, { role: 'SUPPORT' })
    expect((await get(t, '/admin/coupons', u.accessToken)).statusCode).toBe(403)
    expect((await get(t, '/admin/coupons', s.accessToken)).statusCode).toBe(200)
    expect((await get(t, `/admin/coupons/${c.id}/redemptions`, s.accessToken)).statusCode).toBe(200)
    expect((await send(t, 'POST', '/admin/coupons', { code: code(), amountCents: 1 }, bearer(s.accessToken))).statusCode).toBe(403)
    expect((await send(t, 'PATCH', `/admin/coupons/${c.id}`, { active: false }, bearer(s.accessToken))).statusCode).toBe(403)
  })

  it('validação: código duplicado (sem diferenciar caixa) 409; valor 0/negativo/acima do teto, código inválido, campo extra → 400', async () => {
    const c = await mkCoupon()
    expect((await send(t, 'POST', '/admin/coupons', { code: c.code.toLowerCase(), amountCents: 1 }, bearer(admin.accessToken))).statusCode).toBe(409)
    for (const body of [
      { code: code(), amountCents: 0 },
      { code: code(), amountCents: -5 },
      { code: code(), amountCents: 100_001 },
      { code: 'a b', amountCents: 1 },
      { code: code(), amountCents: 1, redemptionsCount: 0 },
      { code: code(), amountCents: 1, perUserLimit: 0 },
      { code: code(), amountCents: 1, endsAt: new Date(Date.now() - 1000).toISOString() },
    ]) {
      expect((await send(t, 'POST', '/admin/coupons', body, bearer(admin.accessToken))).statusCode, JSON.stringify(body)).toBe(400)
    }
  })

  it('congelamento: após o 1º resgate valor e newAccountsOnly → 409 COUPON_LOCKED; maxRedemptions abaixo do usado → 400; desativar funciona', async () => {
    const c = await mkCoupon({ maxRedemptions: 5 })
    await redeem((await userWithToken(t)).accessToken, c.code)
    await redeem((await userWithToken(t)).accessToken, c.code)
    const h = bearer(admin.accessToken)
    const lock = await send(t, 'PATCH', `/admin/coupons/${c.id}`, { amountCents: 9999 }, h)
    expect(lock.statusCode).toBe(409)
    expect(lock.json().error.code).toBe('COUPON_LOCKED')
    expect((await send(t, 'PATCH', `/admin/coupons/${c.id}`, { newAccountsOnly: true }, h)).statusCode).toBe(409)
    expect((await send(t, 'PATCH', `/admin/coupons/${c.id}`, { maxRedemptions: 1 }, h)).statusCode).toBe(400)
    expect((await send(t, 'PATCH', `/admin/coupons/${c.id}`, { active: false }, h)).statusCode).toBe(200)
    expect((await redeem((await userWithToken(t)).accessToken, c.code)).statusCode).toBe(422)
    const red = await get(t, `/admin/coupons/${c.id}/redemptions`, admin.accessToken)
    expect(red.json().meta.total).toBe(2)
  })

  it('resgate de usuário suspenso é impossível (token cai) e o cupom não conta', async () => {
    const c = await mkCoupon({ maxRedemptions: 1 })
    const u = await createUser(t)
    const { accessToken } = await login(t, u.email)
    await t.db.update(users).set({ status: 'SUSPENDED' }).where(eq(users.id, u.id))
    expect((await redeem(accessToken, c.code)).statusCode).toBe(401)
    const [row] = await t.db.select().from(coupons).where(eq(coupons.id, c.id))
    expect(row!.redemptionsCount).toBe(0)
  })
})
