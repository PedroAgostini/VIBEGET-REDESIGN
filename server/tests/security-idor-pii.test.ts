import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { applyCashMovement } from '../src/modules/cash/service.js'
import { applyWalletMovement } from '../src/modules/wallet/service.js'
import { bearer, createLiveVibe, createTestApp, userWithToken, type TestContext } from './helpers.js'

/**
 * IDOR: um usuário nunca vê nem mexe no que é de outro (sempre 404, sem revelar que existe).
 * Vazamento: rotas públicas não carregam e-mail, CPF, telefone nem id de usuário.
 * Exposição: erros da API não revelam stack, SQL nem detalhes internos.
 */

let t: TestContext
type U = Awaited<ReturnType<typeof userWithToken>>
let owner: U
let intruder: U
let seller: U
const ids: Record<string, string> = {}

const api = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, token?: string, payload?: object, headers: Record<string, string> = {}) =>
  t.app.inject({ method, url: `/api/v1${url}`, headers: { ...(token ? bearer(token) : {}), ...headers }, ...(payload ? { payload } : {}) })
const giveCash = (userId: string, cents: number) =>
  t.db.transaction((tx) => applyCashMovement(tx, { userId, amountCents: cents, type: 'ADJUSTMENT', reason: 'teste' }))
const giveGetcoin = (userId: string, cents: number) =>
  t.db.transaction((tx) => applyWalletMovement(tx, { userId, amountCents: cents, type: 'ADJUSTMENT', reason: 'teste' }))

beforeAll(async () => {
  t = await createTestApp()
  owner = await userWithToken(t)
  intruder = await userWithToken(t)
  seller = await userWithToken(t)

  // Recursos do "owner": um Get pago com saldo, um Get pendente (Pix), uma compra de GetCoin, um anúncio e um pedido.
  const { vibe } = await createLiveVibe(t)
  await giveCash(owner.id, 10_000)
  const get = await api('POST', `/vibes/${vibe.id}/gets`, owner.accessToken, { cashCents: 1000, method: 'BALANCE' }, { 'idempotency-key': 'idor-get-0001' })
  expect(get.statusCode, get.body).toBe(201)
  ids.get = get.json().data.get.id
  const pix = await api('POST', `/vibes/${vibe.id}/gets`, owner.accessToken, { cashCents: 1200, method: 'PIX' }, { 'idempotency-key': 'idor-get-0002' })
  expect(pix.statusCode, pix.body).toBe(201)
  ids.payment = pix.json().data.payment.id
  const buy = await api('POST', '/me/getcoin-purchases', owner.accessToken, { customGetcoinsCents: 2000, method: 'PIX' }, { 'idempotency-key': 'idor-buy-0001' })
  expect(buy.statusCode, buy.body).toBe(201)
  ids.purchase = buy.json().data.id
  await giveGetcoin(owner.id, 5000)
  const listing = await api('POST', '/me/market/listings', owner.accessToken, { getcoinsCents: 2000, unitPriceCents: 100 })
  expect(listing.statusCode, listing.body).toBe(201)
  ids.listing = listing.json().data.id
  await giveGetcoin(seller.id, 5000)
  const sellerListing = (await api('POST', '/me/market/listings', seller.accessToken, { getcoinsCents: 2000, unitPriceCents: 100 })).json().data.id
  const ord = await api('POST', `/market/listings/${sellerListing}/orders`, owner.accessToken, { getcoinsCents: 1000, method: 'PIX' }, { 'idempotency-key': 'idor-order-001' })
  expect(ord.statusCode, ord.body).toBe(201)
  ids.order = ord.json().data.id
})
afterAll(async () => {
  await t.close()
})

describe('IDOR: recursos de outro usuário', () => {
  it('leituras por id respondem 404 para quem não é o dono', async () => {
    expect((await api('GET', `/me/gets/${ids.get}`, owner.accessToken)).statusCode).toBe(200)
    for (const url of [`/me/gets/${ids.get}`, `/me/getcoin-purchases/${ids.purchase}`, `/me/market/orders/${ids.order}`]) {
      const r = await api('GET', url, intruder.accessToken)
      expect(r.statusCode, url).toBe(404)
      expect(r.body).not.toContain(owner.email)
    }
  })

  it('ações sobre recursos de outro respondem 404 e não mudam nada', async () => {
    expect((await api('POST', `/me/market/listings/${ids.listing}/cancel`, intruder.accessToken)).statusCode).toBe(404)
    expect((await api('POST', `/payments/${ids.payment}/simulate`, intruder.accessToken, { status: 'PAID' })).statusCode).toBe(404)
    const mine = (await api('GET', '/me/market/listings', owner.accessToken)).json().data
    expect(mine.find((l: { id: string }) => l.id === ids.listing).status).toBe('ACTIVE')
  })

  it('listas "minhas" nunca trazem itens de outro usuário', async () => {
    for (const url of ['/me/gets', '/me/getcoin-purchases', '/me/market/listings', '/me/market/orders', '/me/withdrawals', '/me/prizes']) {
      const r = await api('GET', url, intruder.accessToken)
      expect(r.statusCode, url).toBe(200)
      for (const id of Object.values(ids)) expect(r.body, `${url} vazou ${id}`).not.toContain(id)
    }
  })
})

describe('vazamento de dados pessoais em rotas públicas', () => {
  it('vitrine, página da Vibe e marketplace não trazem e-mail, CPF, telefone nem id de usuário', async () => {
    const vibes = (await api('GET', '/vibes')).json().data as Array<{ slug: string }>
    const pages = [await api('GET', '/vibes'), await api('GET', '/market/listings')]
    for (const v of vibes.slice(0, 5)) pages.push(await api('GET', `/vibes/${v.slug}`))
    for (const p of pages) {
      expect(p.statusCode).toBe(200)
      for (const u of [owner, intruder, seller]) {
        expect(p.body).not.toContain(u.email)
        expect(p.body).not.toContain(u.id)
      }
      expect(p.body).not.toMatch(/"(email|cpf|phone|passwordHash|birthDate|pixKey)"/)
      expect(p.body).not.toMatch(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/)
    }
  })
})

describe('a API não se expõe', () => {
  it('rota inexistente: 404 genérico, sem listar rotas nem tecnologia', async () => {
    const r = await t.app.inject({ method: 'GET', url: '/api/v1/nao-existe' })
    expect(r.statusCode).toBe(404)
    expect(r.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'Rota não encontrada.' } })
    expect(r.headers['x-powered-by']).toBeUndefined()
    expect(r.headers.server).toBeUndefined()
  })

  it('JSON malformado e id inválido: mensagem genérica, sem stack nem SQL', async () => {
    const bad = await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'fetch' },
      payload: '{"email":',
    })
    expect(bad.statusCode).toBe(400)
    const weird = await api('GET', "/me/gets/1' OR '1'='1", owner.accessToken)
    expect([400, 404]).toContain(weird.statusCode)
    for (const r of [bad, weird]) {
      expect(r.body).not.toMatch(/stack|at \w+ \(|SELECT|INSERT|postgres|pglite|drizzle|node_modules/i)
    }
  })

  it('não há documentação nem painel da API publicados', async () => {
    for (const url of ['/docs', '/documentation', '/swagger', '/api/v1/docs', '/api/v1/openapi.json', '/.env', '/api/v1/.env']) {
      expect((await t.app.inject({ method: 'GET', url })).statusCode, url).toBe(404)
    }
  })
})
