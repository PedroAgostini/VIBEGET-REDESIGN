/**
 * Sanidade do builder: exercita cada rota da seção 7 ao menos uma vez.
 * Não substitui a suíte do QA (casos de borda, concorrência, segurança detalhada).
 */
import { createHmac } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  bearer,
  createLiveVibe,
  createTestApp,
  createUser,
  CSRF,
  login,
  PASSWORD,
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

const get = (url: string, token?: string) =>
  t.app.inject({ method: 'GET', url: `/api/v1${url}`, headers: token ? bearer(token) : {} })
const send = (method: 'POST' | 'PATCH' | 'DELETE', url: string, payload: object | undefined, headers: Record<string, string> = {}) =>
  t.app.inject({ method, url: `/api/v1${url}`, headers, ...(payload ? { payload } : {}) })

describe('rotas públicas', () => {
  it('GET /vibes lista com meta e filtros', async () => {
    await createLiveVibe(t)
    const res = await get('/vibes?category=smartphones&status=LIVE&page=1&pageSize=5')
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.meta).toMatchObject({ page: 1, pageSize: 5 })
    expect(body.data[0]).toHaveProperty('product.name')
    expect((await get('/vibes?pageSize=500')).statusCode).toBe(400)
    expect((await get('/vibes?foo=1')).statusCode).toBe(400)
  })
})

describe('auth', () => {
  it('register valida senha comum, strict e aceite de termos', async () => {
    const base = { name: 'Teste', email: `r${Date.now()}@teste.vibeget.dev`, acceptTerms: true }
    const weak = await send('POST', '/auth/register', { ...base, password: 'senha12345' }, CSRF)
    expect(weak.statusCode).toBe(400)
    const extra = await send('POST', '/auth/register', { ...base, password: 'Senha-Forte-123', role: 'ADMIN' }, CSRF)
    expect(extra.statusCode).toBe(400)
    const noTerms = await send('POST', '/auth/register', { ...base, password: 'Senha-Forte-123', acceptTerms: false }, CSRF)
    expect(noTerms.statusCode).toBe(400)
  })

  it('lockout após 5 falhas', async () => {
    const u = await createUser(t)
    for (let i = 0; i < 5; i++) {
      await send('POST', '/auth/login', { email: u.email, password: 'errada-errada' }, CSRF)
    }
    const res = await send('POST', '/auth/login', { email: u.email, password: PASSWORD }, CSRF)
    expect(res.statusCode).toBe(401)
  })

  it('forgot/reset revoga sessões; troca de senha; logout; logout-all', async () => {
    const u = await userWithToken(t)
    const forgot = await send('POST', '/auth/forgot-password', { email: u.email })
    expect(forgot.statusCode).toBe(202)
    expect((await send('POST', '/auth/forgot-password', { email: 'nao@existe.dev' })).statusCode).toBe(202)
    const token = t.mailer.last('PASSWORD_RESET', u.email)!.token
    const newPw = 'Nova-Senha-Segura-99'
    expect((await send('POST', '/auth/reset-password', { token, password: newPw })).statusCode).toBe(204)
    expect((await get('/auth/me', u.accessToken)).statusCode).toBe(401) // sessão revogada
    expect((await send('POST', '/auth/reset-password', { token, password: newPw })).statusCode).toBe(400) // uso único

    const s = await login(t, u.email, newPw)
    const ch = await send(
      'PATCH',
      '/auth/password',
      { currentPassword: newPw, newPassword: 'Outra-Senha-Segura-77' },
      { ...CSRF, ...bearer(s.accessToken) },
    )
    expect(ch.statusCode).toBe(200)
    expect((await get('/auth/me', s.accessToken)).statusCode).toBe(401)
    const newAccess = ch.json().accessToken as string
    expect((await get('/auth/me', newAccess)).statusCode).toBe(200)

    const out = await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: CSRF,
      cookies: { vg_rt: refreshCookieOf(ch)! },
    })
    expect(out.statusCode).toBe(204)
    expect((await get('/auth/me', newAccess)).statusCode).toBe(401)

    const s2 = await login(t, u.email, 'Outra-Senha-Segura-77')
    expect((await send('POST', '/auth/logout-all', undefined, { ...CSRF, ...bearer(s2.accessToken) })).statusCode).toBe(204)
    expect((await get('/auth/me', s2.accessToken)).statusCode).toBe(401)
  })

  it('resend-verification', async () => {
    const u = await userWithToken(t, { verified: false })
    expect((await send('POST', '/auth/resend-verification', undefined, bearer(u.accessToken))).statusCode).toBe(202)
    expect(t.mailer.last('EMAIL_VERIFY', u.email)).toBeTruthy()
  })
})

describe('usuário logado', () => {
  it('dashboard, PATCH /me, gets, wallet, export, delete', async () => {
    const u = await userWithToken(t, { cpf: null, birthDate: null })
    const dash = await get('/me/dashboard', u.accessToken)
    expect(dash.statusCode).toBe(200)
    expect(dash.json().data).toMatchObject({ balanceCents: 0, wins: 0, level: 'EXPLORADOR' })

    const p1 = await send('PATCH', '/me', { name: 'Nome Novo', cpf: '529.982.247-25', birthDate: '1990-01-01' }, bearer(u.accessToken))
    expect(p1.statusCode).toBe(200)
    expect(p1.json().user.cpfMasked).toBe('***.982.247-**')
    const p2 = await send('PATCH', '/me', { cpf: '111.444.777-35' }, bearer(u.accessToken))
    expect(p2.statusCode).toBe(409)
    expect((await send('PATCH', '/me', { role: 'ADMIN' }, bearer(u.accessToken))).statusCode).toBe(400)

    expect((await get('/me/gets', u.accessToken)).statusCode).toBe(200)
    expect((await get('/me/wallet', u.accessToken)).json()).toMatchObject({ balanceCents: 0, meta: { page: 1 } })
    const exp = await get('/me/export', u.accessToken)
    expect(exp.statusCode).toBe(200)
    expect(exp.body).not.toContain('passwordHash')
    expect(exp.body).not.toContain('tokenHash')

    expect((await send('DELETE', '/me', { password: 'errada' }, bearer(u.accessToken))).statusCode).toBe(400)
    expect((await send('DELETE', '/me', { password: PASSWORD }, bearer(u.accessToken))).statusCode).toBe(204)
    expect((await get('/auth/me', u.accessToken)).statusCode).toBe(401)
  })

  it('Get: requisitos, mínimo, GetCoin > cash, sem Idempotency-Key', async () => {
    const { vibe } = await createLiveVibe(t, { minGetCents: 500 })
    const noCpf = await userWithToken(t, { cpf: null })
    const u = await userWithToken(t)
    const url = `/vibes/${vibe.id}/gets`
    expect((await send('POST', url, { cashCents: 500, method: 'PIX' }, bearer(u.accessToken))).statusCode).toBe(400)
    const h = (tk: string, k: string) => ({ ...bearer(tk), 'idempotency-key': k })
    expect((await send('POST', url, { cashCents: 500, method: 'PIX' }, h(noCpf.accessToken, 'k-nocpf-01'))).statusCode).toBe(422)
    expect((await send('POST', url, { cashCents: 400, method: 'PIX' }, h(u.accessToken, 'k-min-0001'))).statusCode).toBe(422)
    expect(
      (await send('POST', url, { cashCents: 500, getcoinCents: 600, method: 'PIX' }, h(u.accessToken, 'k-gc-00001'))).statusCode,
    ).toBe(400)
    // sem saldo de GetCoin
    const r = await send('POST', url, { cashCents: 500, getcoinCents: 100, method: 'PIX' }, h(u.accessToken, 'k-gc-00002'))
    expect(r.statusCode).toBe(422)
    expect(r.json().error.code).toBe('INSUFFICIENT_GETCOIN')
  })
})

describe('pagamentos', () => {
  it('webhook exige HMAC e confirma o pagamento', async () => {
    const { vibe } = await createLiveVibe(t)
    const u = await userWithToken(t)
    const g = await send('POST', `/vibes/${vibe.id}/gets`, { cashCents: 500, method: 'PIX' }, { ...bearer(u.accessToken), 'idempotency-key': 'k-webhook-1' })
    expect(g.statusCode).toBe(201)
    const pay = await t.db.query.payments.findFirst({ where: (p, { eq }) => eq(p.id, g.json().data.payment.id) })
    const externalId = pay!.externalId
    const payload = JSON.stringify({ externalId, status: 'PAID' })
    const bad = await t.app.inject({
      method: 'POST',
      url: '/api/v1/payments/webhook',
      headers: { 'content-type': 'application/json', 'x-signature': 'deadbeef' },
      payload,
    })
    expect(bad.statusCode).toBe(401)
    const sig = createHmac('sha256', t.env.PAYMENT_WEBHOOK_SECRET).update(payload).digest('hex')
    const ok = await t.app.inject({
      method: 'POST',
      url: '/api/v1/payments/webhook',
      headers: { 'content-type': 'application/json', 'x-signature': `sha256=${sig}` },
      payload,
    })
    expect(ok.statusCode).toBe(200)
    expect(ok.json()).toEqual({ received: true, changed: true })
    const mine = await get('/me/gets', u.accessToken)
    expect(mine.json().data[0].status).toBe('CONFIRMED')
  })
})

describe('admin', () => {
  it('usuários, produtos, Vibes, gets e audit log', async () => {
    const admin = await userWithToken(t, { role: 'ADMIN' })
    const H = bearer(admin.accessToken)
    const u = await createUser(t, { name: 'Carlos Pereira' })

    const list = await get('/admin/users?q=carlos&pageSize=10', admin.accessToken)
    expect(list.statusCode).toBe(200)
    expect(list.json().data.some((x: { id: string }) => x.id === u.id)).toBe(true)
    expect((await get(`/admin/users/${u.id}`, admin.accessToken)).json().data).toHaveProperty('balanceCents', 0)

    expect((await send('PATCH', `/admin/users/${admin.id}`, { role: 'USER' }, H)).statusCode).toBe(403)
    const sus = await send('PATCH', `/admin/users/${u.id}`, { status: 'SUSPENDED', reason: 'teste' }, H)
    expect(sus.statusCode).toBe(200)
    expect(sus.json().data.status).toBe('SUSPENDED')

    const neg = await send('POST', `/admin/users/${u.id}/wallet-adjustments`, { amountCents: -1, reason: 'teste negativo' }, H)
    expect(neg.statusCode).toBe(422)

    const prod = await send(
      'POST',
      '/admin/products',
      { slug: `prod-${Date.now()}`, name: 'Fone X', category: 'audio', originalPriceCents: 99_900, imageUrl: '/img/x.jpg' },
      H,
    )
    expect(prod.statusCode).toBe(201)
    const pid = prod.json().data.id
    expect((await send('PATCH', `/admin/products/${pid}`, { name: 'Fone X2' }, H)).json().data.name).toBe('Fone X2')
    expect((await get('/admin/products?category=audio', admin.accessToken)).json().meta.total).toBeGreaterThan(0)

    const now = Date.now()
    const vibe = await send(
      'POST',
      '/admin/vibes',
      {
        productId: pid,
        slug: `vibe-fone-${now}`,
        status: 'DRAFT',
        minGetCents: 395,
        startsAt: new Date(now - 1000).toISOString(),
        endsAt: new Date(now + 86_400_000).toISOString(),
      },
      H,
    )
    expect(vibe.statusCode).toBe(201)
    const vid = vibe.json().data.id
    expect((await send('PATCH', `/admin/vibes/${vid}`, { status: 'LIVE' }, H)).json().data.status).toBe('LIVE')
    expect((await send('PATCH', `/admin/vibes/${vid}`, { minGetCents: 100 }, H)).statusCode).toBe(409)
    expect((await send('PATCH', `/admin/vibes/${vid}`, { status: 'CANCELLED' }, H)).json().data.status).toBe('CANCELLED')
    expect((await send('POST', `/admin/vibes/${vid}/close`, undefined, H)).statusCode).toBe(409)
    expect((await get('/admin/vibes?status=CANCELLED', admin.accessToken)).statusCode).toBe(200)
    expect((await get('/admin/gets', admin.accessToken)).statusCode).toBe(200)

    const logs = await get('/admin/audit-logs?action=USER_UPDATED', admin.accessToken)
    expect(logs.statusCode).toBe(200)
    expect(logs.json().data.length).toBeGreaterThan(0)
  })
})

describe('rate limit', () => {
  it('login é limitado por IP quando ligado', async () => {
    const rl = await createTestApp({ rateLimit: true })
    try {
      let last = 0
      for (let i = 0; i < 11; i++) {
        const r = await rl.app.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          headers: CSRF,
          payload: { email: 'x@teste.dev', password: 'qualquer-coisa' },
        })
        last = r.statusCode
      }
      expect(last).toBe(429)
    } finally {
      await rl.close()
    }
  })
})

describe('banco', () => {
  it('getcoin_ledger é imutável e wallets não aceita saldo negativo', async () => {
    const { sql } = await import('drizzle-orm')
    const u = await createUser(t)
    await t.db.execute(sql`UPDATE wallets SET balance_cents = 10 WHERE user_id = ${u.id}`)
    await t.db.execute(
      sql`INSERT INTO getcoin_ledger (id, user_id, amount_cents, balance_after_cents, type) VALUES (gen_random_uuid(), ${u.id}, 10, 10, 'ADJUSTMENT')`,
    )
    await expect(t.db.execute(sql`UPDATE getcoin_ledger SET amount_cents = 99 WHERE user_id = ${u.id}`)).rejects.toThrow()
    await expect(t.db.execute(sql`DELETE FROM getcoin_ledger WHERE user_id = ${u.id}`)).rejects.toThrow()
    await expect(t.db.execute(sql`UPDATE wallets SET balance_cents = -1 WHERE user_id = ${u.id}`)).rejects.toThrow()
  })
})
