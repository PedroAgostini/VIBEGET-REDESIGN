import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  bearer,
  createLiveVibe,
  createTestApp,
  CSRF,
  getUserRow,
  nextCpf,
  refreshCookieOf,
  userWithToken,
  type TestContext,
} from './helpers.js'

let t: TestContext

beforeAll(async () => {
  t = await createTestApp()
})
afterAll(async () => {
  await t.close()
})

describe('smoke', () => {
  it('GET /health responde 200', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/v1/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ status: 'ok' })
  })

  it('rota inexistente devolve erro no formato padrão', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/v1/nao-existe' })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: { code: 'NOT_FOUND', message: expect.any(String) } })
  })

  it('register -> me -> login -> refresh (rotação) -> reuso revoga a família', async () => {
    const email = `novo.${Date.now()}@teste.vibeget.dev`
    const reg = await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      headers: CSRF,
      payload: {
        name: 'Maria Souza',
        email,
        password: 'Uma-Senha-Bem-Forte-42',
        cpf: nextCpf(),
        birthDate: '1995-01-20',
        acceptTerms: true,
      },
    })
    expect(reg.statusCode).toBe(201)
    const regBody = reg.json()
    expect(regBody.user).toMatchObject({ email, level: 'EXPLORADOR', role: 'USER', emailVerified: false })
    expect(regBody.user.passwordHash).toBeUndefined()
    const cookie = reg.cookies.find((c) => c.name === 'vg_rt')!
    expect(cookie.httpOnly).toBe(true)
    expect(cookie.sameSite).toBe('Strict')
    expect(cookie.path).toBe('/api/v1/auth')

    // e-mail de verificação capturado pelo MemoryMailer
    const mail = t.mailer.last('EMAIL_VERIFY', email)
    expect(mail?.token).toBeTruthy()
    const ver = await t.app.inject({ method: 'POST', url: '/api/v1/auth/verify-email', payload: { token: mail!.token } })
    expect(ver.statusCode).toBe(204)

    const me = await t.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: bearer(regBody.accessToken) })
    expect(me.statusCode).toBe(200)
    expect(me.json().user.emailVerified).toBe(true)

    const login = await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: CSRF,
      payload: { email, password: 'Uma-Senha-Bem-Forte-42' },
    })
    expect(login.statusCode).toBe(200)
    const rt1 = refreshCookieOf(login)!

    const r1 = await t.app.inject({ method: 'POST', url: '/api/v1/auth/refresh', headers: CSRF, cookies: { vg_rt: rt1 } })
    expect(r1.statusCode).toBe(200)
    const rt2 = refreshCookieOf(r1)!
    expect(rt2).not.toBe(rt1)

    // reuso do token antigo -> 401 e a família toda (rt2) deixa de valer
    const reuse = await t.app.inject({ method: 'POST', url: '/api/v1/auth/refresh', headers: CSRF, cookies: { vg_rt: rt1 } })
    expect(reuse.statusCode).toBe(401)
    const after = await t.app.inject({ method: 'POST', url: '/api/v1/auth/refresh', headers: CSRF, cookies: { vg_rt: rt2 } })
    expect(after.statusCode).toBe(401)
  })

  it('login sem header CSRF é bloqueado', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'x@y.com', password: 'qualquer' },
    })
    expect(res.statusCode).toBe(403)
    expect(res.json().error.code).toBe('CSRF_REJECTED')
  })

  it('login com senha errada é genérico', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: CSRF,
      payload: { email: 'ninguem@teste.vibeget.dev', password: 'errada-errada' },
    })
    expect(res.statusCode).toBe(401)
    expect(res.json().error.code).toBe('INVALID_CREDENTIALS')
  })

  it('rota admin: 401 sem token, 403 para USER, 200 para SUPPORT e ADMIN', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/admin/dashboard' })).statusCode).toBe(401)
    const user = await userWithToken(t)
    const res = await t.app.inject({ method: 'GET', url: '/api/v1/admin/dashboard', headers: bearer(user.accessToken) })
    expect(res.statusCode).toBe(403)
    const support = await userWithToken(t, { role: 'SUPPORT' })
    expect(
      (await t.app.inject({ method: 'GET', url: '/api/v1/admin/users', headers: bearer(support.accessToken) })).statusCode,
    ).toBe(200)
    // SUPPORT não escreve
    const denied = await t.app.inject({
      method: 'POST',
      url: `/api/v1/admin/users/${user.id}/wallet-adjustments`,
      headers: bearer(support.accessToken),
      payload: { amountCents: 100, reason: 'teste de permissão' },
    })
    expect(denied.statusCode).toBe(403)
    const admin = await userWithToken(t, { role: 'ADMIN' })
    expect(
      (await t.app.inject({ method: 'GET', url: '/api/v1/admin/dashboard', headers: bearer(admin.accessToken) })).statusCode,
    ).toBe(200)
  })

  it('fluxo Get -> pagamento -> encerramento com cashback', async () => {
    const admin = await userWithToken(t, { role: 'ADMIN' })
    const a = await userWithToken(t, { name: 'Ana Lima' })
    const b = await userWithToken(t, { name: 'Bruno Costa' })
    const { vibe } = await createLiveVibe(t)

    // B ganha 1000 GetCoin via ajuste do admin para turbinar o Get
    const adj = await t.app.inject({
      method: 'POST',
      url: `/api/v1/admin/users/${b.id}/wallet-adjustments`,
      headers: bearer(admin.accessToken),
      payload: { amountCents: 1000, reason: 'Crédito de teste' },
    })
    expect(adj.statusCode).toBe(201)

    const give = (token: string, key: string, payload: object) =>
      t.app.inject({
        method: 'POST',
        url: `/api/v1/vibes/${vibe.id}/gets`,
        headers: { ...bearer(token), 'idempotency-key': key },
        payload,
      })

    const ga = await give(a.accessToken, 'chave-a-000001', { cashCents: 1000, getcoinCents: 0, method: 'PIX' })
    expect(ga.statusCode).toBe(201)
    const again = await give(a.accessToken, 'chave-a-000001', { cashCents: 1000, getcoinCents: 0, method: 'PIX' })
    expect(again.statusCode).toBe(200)
    expect(again.json().data.get.id).toBe(ga.json().data.get.id)

    const gb = await give(b.accessToken, 'chave-b-000001', { cashCents: 800, getcoinCents: 800, method: 'PIX' })
    expect(gb.statusCode).toBe(201)
    expect(gb.json().data.get.totalCents).toBe(1600)

    // A tenta simular pagamento de B -> 404 (sem IDOR)
    const idor = await t.app.inject({
      method: 'POST',
      url: `/api/v1/payments/${gb.json().data.payment.id}/simulate`,
      headers: bearer(a.accessToken),
      payload: { status: 'PAID' },
    })
    expect(idor.statusCode).toBe(404)

    for (const [who, r] of [
      [a, ga],
      [b, gb],
    ] as const) {
      const pay = await t.app.inject({
        method: 'POST',
        url: `/api/v1/payments/${r.json().data.payment.id}/simulate`,
        headers: bearer(who.accessToken),
        payload: { status: 'PAID' },
      })
      expect(pay.statusCode).toBe(200)
    }

    const close = await t.app.inject({ method: 'POST', url: `/api/v1/admin/vibes/${vibe.id}/close`, headers: bearer(admin.accessToken) })
    expect(close.statusCode).toBe(200)
    expect(close.json().data).toMatchObject({ winnerGetId: gb.json().data.get.id, cashbackIssuedCents: 400 })

    // idempotente
    const close2 = await t.app.inject({ method: 'POST', url: `/api/v1/admin/vibes/${vibe.id}/close`, headers: bearer(admin.accessToken) })
    expect(close2.json().data).toMatchObject({ alreadySettled: true, cashbackIssuedCents: 0 })

    const wa = await t.app.inject({ method: 'GET', url: '/api/v1/me/wallet', headers: bearer(a.accessToken) })
    expect(wa.json().balanceCents).toBe(400)
    expect((await getUserRow(t, b.id)).level).toBe('VIBER')

    const pub = await t.app.inject({ method: 'GET', url: `/api/v1/vibes/${vibe.slug}` })
    expect(pub.statusCode).toBe(200)
    expect(pub.json().data.winner).toEqual({ totalCents: 1600, by: 'Bruno C.' })
  })
})
