/**
 * QA — matriz de permissões USER/SUPPORT/ADMIN em TODAS as rotas /admin, regras de role e IDOR.
 */
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { users } from '../src/db/schema.js'
import {
  bearer,
  createLiveVibe,
  createTestApp,
  createUser,
  CSRF,
  getUserRow,
  login,
  userWithToken,
  type TestContext,
} from './helpers.js'
import { externalIdOfGet, fund, get, placeGet, send } from './qa-helpers.js'

let t: TestContext
let admin: Awaited<ReturnType<typeof userWithToken>>
let support: Awaited<ReturnType<typeof userWithToken>>
let user: Awaited<ReturnType<typeof userWithToken>>
let target: { id: string }
let vibeId: string
let productId: string

beforeAll(async () => {
  t = await createTestApp()
  admin = await userWithToken(t, { role: 'ADMIN' })
  support = await userWithToken(t, { role: 'SUPPORT' })
  user = await userWithToken(t)
  target = await createUser(t)
  const { vibe, product } = await createLiveVibe(t, { status: 'DRAFT' })
  vibeId = vibe.id
  productId = product.id
})
afterAll(async () => {
  await t.close()
})

const Z = '00000000-0000-4000-8000-000000000000'
type Route = { method: 'GET' | 'POST' | 'PATCH'; url: () => string; body?: () => unknown; write: boolean }
const routes: Route[] = [
  { method: 'GET', url: () => '/admin/dashboard', write: false },
  { method: 'GET', url: () => '/admin/users', write: false },
  { method: 'GET', url: () => `/admin/users/${target.id}`, write: false },
  { method: 'PATCH', url: () => `/admin/users/${target.id}`, body: () => ({ status: 'ACTIVE' }), write: true },
  { method: 'POST', url: () => `/admin/users/${target.id}/wallet-adjustments`, body: () => ({ amountCents: 1, reason: 'teste de rbac' }), write: true },
  { method: 'GET', url: () => '/admin/products', write: false },
  {
    method: 'POST',
    url: () => '/admin/products',
    body: () => ({ slug: `rbac-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, name: 'Produto RBAC', category: 'audio', originalPriceCents: 1000 }),
    write: true,
  },
  { method: 'PATCH', url: () => `/admin/products/${productId}`, body: () => ({ name: 'Renomeado' }), write: true },
  { method: 'GET', url: () => '/admin/vibes', write: false },
  {
    method: 'POST',
    url: () => '/admin/vibes',
    body: () => ({
      productId,
      slug: `rbac-v-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      minGetCents: 100,
      startsAt: new Date(Date.now() + 3600_000).toISOString(),
      endsAt: new Date(Date.now() + 7200_000).toISOString(),
    }),
    write: true,
  },
  { method: 'PATCH', url: () => `/admin/vibes/${vibeId}`, body: () => ({ goalGets: 10 }), write: true },
  { method: 'POST', url: () => `/admin/vibes/${Z}/close`, write: true },
  { method: 'GET', url: () => '/admin/gets', write: false },
  { method: 'GET', url: () => '/admin/audit-logs', write: false },
]

const call = (r: Route, token?: string) =>
  t.app.inject({
    method: r.method,
    url: `/api/v1${r.url()}`,
    headers: token ? bearer(token) : {},
    ...(r.body ? { payload: r.body() as object } : {}),
  })

describe('matriz /admin', () => {
  it.each(routes.map((r) => [`${r.method} ${r.url.toString().replace(/^\(\) => /, '')}`, r] as const))(
    '%s: sem token 401, USER 403, SUPPORT lê/não escreve, ADMIN liberado',
    async (_name, r) => {
      expect((await call(r)).statusCode).toBe(401)
      expect((await call(r, user.accessToken)).statusCode).toBe(403)
      const s = await call(r, support.accessToken)
      if (r.write) expect(s.statusCode, s.body).toBe(403)
      else expect(s.statusCode, s.body).toBe(200)
      const a = await call(r, admin.accessToken)
      // close de id inexistente = 404 (passou da autorização)
      expect([200, 201, 404], a.body).toContain(a.statusCode)
      if (!r.url().includes(Z)) expect(a.statusCode, a.body).toBeLessThan(300)
    },
  )

  it('SUPPORT de escrita recusado ANTES da validação do corpo (corpo inválido também 403)', async () => {
    const res = await send(t, 'POST', '/admin/products', { lixo: true }, bearer(support.accessToken))
    expect(res.statusCode).toBe(403)
  })

  it('SUPPORT não vê hash de senha nem CPF completo em /admin/users', async () => {
    const res = await get(t, `/admin/users/${target.id}`, support.accessToken)
    const raw = res.body
    expect(raw).not.toMatch(/passwordHash|argon2/)
    const row = await getUserRow(t, target.id)
    expect(raw).not.toContain(row.cpf!)
  })
})

describe('regras de role', () => {
  it('ninguém muda a própria role/status (ADMIN → 403 SELF_CHANGE_FORBIDDEN)', async () => {
    const res = await send(t, 'PATCH', `/admin/users/${admin.id}`, { role: 'USER' }, bearer(admin.accessToken))
    expect(res.statusCode).toBe(403)
    expect(res.json().error.code).toBe('SELF_CHANGE_FORBIDDEN')
    const res2 = await send(t, 'PATCH', `/admin/users/${admin.id}`, { status: 'SUSPENDED' }, bearer(admin.accessToken))
    expect(res2.statusCode).toBe(403)
  })

  it('SUPPORT não se promove', async () => {
    const res = await send(t, 'PATCH', `/admin/users/${support.id}`, { role: 'ADMIN' }, bearer(support.accessToken))
    expect(res.statusCode).toBe(403)
    expect((await getUserRow(t, support.id)).role).toBe('SUPPORT')
  })

  it('USER não se promove por PATCH /me (400) nem por /admin (403)', async () => {
    expect((await send(t, 'PATCH', '/me', { role: 'ADMIN' }, bearer(user.accessToken))).statusCode).toBe(400)
    expect((await send(t, 'PATCH', `/admin/users/${user.id}`, { role: 'ADMIN' }, bearer(user.accessToken))).statusCode).toBe(403)
    expect((await getUserRow(t, user.id)).role).toBe('USER')
  })

  it('ADMIN promove/rebaixa outro usuário; a mudança derruba as sessões dele e o novo login já vem com a role nova; gera audit', async () => {
    const u = await userWithToken(t)
    const res = await send(t, 'PATCH', `/admin/users/${u.id}`, { role: 'SUPPORT', reason: 'promoção de teste' }, bearer(admin.accessToken))
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().data.role).toBe('SUPPORT')
    expect((await get(t, '/auth/me', u.accessToken)).statusCode).toBe(401)
    const again = await login(t, u.email)
    expect((await get(t, '/admin/dashboard', again.accessToken)).statusCode).toBe(200)
    const logs = await get(t, `/admin/audit-logs?entityId=${u.id}&action=USER_UPDATED`, admin.accessToken)
    expect(logs.json().data[0].metadata).toMatchObject({ from: { role: 'USER' }, to: { role: 'SUPPORT' }, reason: 'promoção de teste' })
  })

  it('último ADMIN ativo: nunca fica sem administrador (A rebaixa B; depois ninguém rebaixa A)', async () => {
    const ctx = await createTestApp()
    try {
      const a = await userWithToken(ctx, { role: 'ADMIN' })
      const b = await userWithToken(ctx, { role: 'ADMIN' })
      const r1 = await send(ctx, 'PATCH', `/admin/users/${b.id}`, { role: 'USER' }, bearer(a.accessToken))
      expect(r1.statusCode, r1.body).toBe(200)
      // B perdeu a sessão e não é mais admin
      expect((await send(ctx, 'PATCH', `/admin/users/${a.id}`, { role: 'USER' }, bearer(b.accessToken))).statusCode).toBe(401)
      const b2 = await login(ctx, b.email)
      expect((await send(ctx, 'PATCH', `/admin/users/${a.id}`, { role: 'USER' }, bearer(b2.accessToken))).statusCode).toBe(403)
      // A não se rebaixa/suspende
      expect((await send(ctx, 'PATCH', `/admin/users/${a.id}`, { status: 'SUSPENDED' }, bearer(a.accessToken))).statusCode).toBe(403)
      // A não exclui a própria conta sendo o último admin
      const del = await send(ctx, 'DELETE', '/me', { password: a.password }, bearer(a.accessToken))
      expect(del.statusCode).toBe(409)
      expect(del.json().error.code).toBe('LAST_ADMIN')
      const [row] = await ctx.db.select().from(users).where(eq(users.id, a.id))
      expect(row!.role).toBe('ADMIN')
      expect(row!.status).toBe('ACTIVE')
    } finally {
      await ctx.close()
    }
  })

  it('ADMIN suspende usuário: sessões caem na hora, login responde 403; reativar permite login', async () => {
    const u = await userWithToken(t)
    const res = await send(t, 'PATCH', `/admin/users/${u.id}`, { status: 'SUSPENDED', reason: 'fraude' }, bearer(admin.accessToken))
    expect(res.statusCode).toBe(200)
    expect((await get(t, '/me/dashboard', u.accessToken)).statusCode).toBe(401)
    const r = await t.app.inject({ method: 'POST', url: '/api/v1/auth/refresh', headers: CSRF, cookies: { vg_rt: u.refreshToken } })
    expect(r.statusCode).toBe(401)
    expect((await send(t, 'POST', '/auth/login', { email: u.email, password: u.password }, CSRF)).statusCode).toBe(403)
    await send(t, 'PATCH', `/admin/users/${u.id}`, { status: 'ACTIVE' }, bearer(admin.accessToken))
    await login(t, u.email)
  })

  it('PATCH /admin/users não aceita status DELETED, campos extras (level, email) nem corpo vazio', async () => {
    const h = bearer(admin.accessToken)
    expect((await send(t, 'PATCH', `/admin/users/${target.id}`, { status: 'DELETED' }, h)).statusCode).toBe(400)
    expect((await send(t, 'PATCH', `/admin/users/${target.id}`, { level: 'VIBER' }, h)).statusCode).toBe(400)
    expect((await send(t, 'PATCH', `/admin/users/${target.id}`, { email: 'x@y.z' }, h)).statusCode).toBe(400)
    expect((await send(t, 'PATCH', `/admin/users/${target.id}`, {}, h)).statusCode).toBe(400)
    expect((await send(t, 'PATCH', `/admin/users/nao-uuid`, { status: 'ACTIVE' }, h)).statusCode).toBe(400)
    expect((await send(t, 'PATCH', `/admin/users/${Z}`, { status: 'ACTIVE' }, h)).statusCode).toBe(404)
  })
})

describe('IDOR', () => {
  it('usuário não simula pagamento de outro (404, sem vazar existência) e o pagamento continua PENDING', async () => {
    const { vibe } = await createLiveVibe(t)
    const a = await userWithToken(t)
    const b = await userWithToken(t)
    const g = await placeGet(t, a.accessToken, vibe.id, { cashCents: 500 })
    expect(g.statusCode, g.body).toBe(201)
    const payId = g.json().data.payment.id
    const res = await send(t, 'POST', `/payments/${payId}/simulate`, { status: 'PAID' }, bearer(b.accessToken))
    expect(res.statusCode).toBe(404)
    const ghost = await send(t, 'POST', `/payments/${Z}/simulate`, { status: 'PAID' }, bearer(b.accessToken))
    expect(res.json()).toEqual(ghost.json())
    // SUPPORT também não
    expect((await send(t, 'POST', `/payments/${payId}/simulate`, { status: 'PAID' }, bearer(support.accessToken))).statusCode).toBe(404)
    // dono consegue
    const own = await send(t, 'POST', `/payments/${payId}/simulate`, { status: 'PAID' }, bearer(a.accessToken))
    expect(own.statusCode).toBe(200)
    expect(own.json().data.status).toBe('PAID')
  })

  it('/me/gets, /me/wallet e /me/dashboard só mostram dados do próprio token', async () => {
    const { vibe } = await createLiveVibe(t)
    const a = await userWithToken(t)
    const b = await userWithToken(t)
    await fund(t, a.id, 1000)
    const g = await placeGet(t, a.accessToken, vibe.id, { cashCents: 500, getcoinCents: 100 })
    const getId = g.json().data.get.id
    const bGets = await get(t, '/me/gets', b.accessToken)
    expect(bGets.json().data).toEqual([])
    expect(bGets.body).not.toContain(getId)
    const bWallet = await get(t, '/me/wallet', b.accessToken)
    expect(bWallet.json().balanceCents).toBe(0)
    expect(bWallet.json().data).toEqual([])
    const bDash = await get(t, '/me/dashboard', b.accessToken)
    expect(bDash.body).not.toContain(getId)
    // query string não troca o usuário
    expect((await get(t, `/me/gets?userId=${a.id}`, b.accessToken)).statusCode).toBe(400)
    expect((await get(t, `/me/wallet?userId=${a.id}`, b.accessToken)).statusCode).toBe(400)
    void externalIdOfGet
  })

  it('Idempotency-Key é por usuário: a mesma chave de A usada por B cria outro Get (não devolve o de A)', async () => {
    const { vibe } = await createLiveVibe(t)
    const a = await userWithToken(t)
    const b = await userWithToken(t)
    const key = `shared-key-${Date.now()}`
    const ga = await placeGet(t, a.accessToken, vibe.id, { cashCents: 500 }, key)
    const gb = await placeGet(t, b.accessToken, vibe.id, { cashCents: 500 }, key)
    expect(ga.statusCode).toBe(201)
    expect(gb.statusCode).toBe(201)
    expect(gb.json().data.get.id).not.toBe(ga.json().data.get.id)
  })

  it('rotas de usuário logado sem token → 401', async () => {
    for (const [m, u] of [
      ['GET', '/me/dashboard'],
      ['GET', '/me/gets'],
      ['GET', '/me/wallet'],
      ['GET', '/me/export'],
      ['PATCH', '/me'],
      ['DELETE', '/me'],
      ['GET', '/auth/me'],
      ['POST', `/vibes/${Z}/gets`],
      ['POST', `/payments/${Z}/simulate`],
    ] as const) {
      const res = await t.app.inject({ method: m, url: `/api/v1${u}`, payload: m === 'GET' ? undefined : {} })
      expect(res.statusCode, `${m} ${u}`).toBe(401)
    }
  })
})
