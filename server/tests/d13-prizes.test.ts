import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { prizeDeliveries } from '../src/db/schema.js'
import { applyCashMovement } from '../src/modules/cash/service.js'
import { bearer, createLiveVibe, createTestApp, PASSWORD, userWithToken, type TestContext } from './helpers.js'

let t: TestContext
let admin: Awaited<ReturnType<typeof userWithToken>>
let support: Awaited<ReturnType<typeof userWithToken>>

beforeAll(async () => {
  t = await createTestApp()
  admin = await userWithToken(t, { role: 'ADMIN' })
  support = await userWithToken(t, { role: 'SUPPORT' })
})
afterAll(async () => {
  await t.close()
})

let seq = 0
const api = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, token?: string, payload?: object, headers: Record<string, string> = {}) =>
  t.app.inject({ method, url: `/api/v1${url}`, headers: { ...(token ? bearer(token) : {}), ...headers }, ...(payload ? { payload } : {}) })

/** Get pago com saldo (confirmado na hora), deixando o saldo em R$ zerado. */
async function balanceGet(u: { id: string; accessToken: string }, vibeId: string, cashCents: number) {
  await t.db.transaction((tx) => applyCashMovement(tx, { userId: u.id, amountCents: cashCents, type: 'ADJUSTMENT', reason: 'teste' }))
  const g = await api('POST', `/vibes/${vibeId}/gets`, u.accessToken, { cashCents, method: 'BALANCE' }, { 'idempotency-key': `prize-get-${++seq}-xyz` })
  expect(g.statusCode, g.body).toBe(201)
}

/** Vibe encerrada: `winner` dá o maior Get, `loser` um menor. */
async function wonVibe() {
  const winner = await userWithToken(t)
  const loser = await userWithToken(t)
  const { vibe } = await createLiveVibe(t)
  await balanceGet(loser, vibe.id, 1000)
  await balanceGet(winner, vibe.id, 2000)
  const close = await api('POST', `/admin/vibes/${vibe.id}/close`, admin.accessToken)
  expect(close.statusCode, close.body).toBe(200)
  const prize = (await api('GET', '/me/prizes', winner.accessToken)).json().data[0]
  return { winner, loser, vibe, prize }
}

const ADDRESS = {
  recipientName: 'Maria Vencedora',
  phone: '(11) 98765-4321',
  cep: '01310-100',
  street: 'Avenida Paulista',
  number: '1000',
  district: 'Bela Vista',
  city: 'São Paulo',
  state: 'SP',
}

describe('D13 — entrega do prêmio', () => {
  it('o encerramento cria a entrega só para o vencedor, uma vez, aguardando endereço', async () => {
    const { winner, loser, vibe, prize } = await wonVibe()
    expect(prize).toMatchObject({ status: 'AWAITING_ADDRESS', winningGetCents: 2000, address: null, vibe: { id: vibe.id } })
    expect(prize.product.name).toBeTruthy()
    expect((await api('GET', '/me/prizes', loser.accessToken)).json().data).toEqual([])
    expect((await api('GET', '/me/dashboard', winner.accessToken)).json().data.prizesAwaitingAddress).toBe(1)
    // encerrar de novo não duplica
    await api('POST', `/admin/vibes/${vibe.id}/close`, admin.accessToken)
    expect(await t.db.select().from(prizeDeliveries).where(eq(prizeDeliveries.vibeId, vibe.id))).toHaveLength(1)
  })

  it('vencedor confirma e troca o endereço; validação; outro usuário recebe 404', async () => {
    const { winner, loser, prize } = await wonVibe()
    const bad = await api('PUT', `/me/prizes/${prize.id}/address`, winner.accessToken, { ...ADDRESS, state: 'XX', phone: '123' })
    expect(bad.statusCode).toBe(400)
    expect((await api('PUT', `/me/prizes/${prize.id}/address`, loser.accessToken, ADDRESS)).statusCode).toBe(404)
    const ok = await api('PUT', `/me/prizes/${prize.id}/address`, winner.accessToken, ADDRESS)
    expect(ok.statusCode, ok.body).toBe(200)
    expect(ok.json().data).toMatchObject({
      status: 'PREPARING',
      recipientName: 'Maria Vencedora',
      phone: '11987654321',
      address: { cep: '01310100', street: 'Avenida Paulista', number: '1000', complement: null, state: 'SP' },
    })
    expect(ok.json().data.addressConfirmedAt).toBeTruthy()
    const changed = await api('PUT', `/me/prizes/${prize.id}/address`, winner.accessToken, { ...ADDRESS, number: '2000', complement: 'Apto 12' })
    expect(changed.json().data.address).toMatchObject({ number: '2000', complement: 'Apto 12' })
    expect((await api('GET', '/me/dashboard', winner.accessToken)).json().data.prizesAwaitingAddress).toBe(0)
  })

  it('admin: SUPPORT só lê; envio exige rastreio; entregue só depois de enviado; endereço trava após envio', async () => {
    const { winner, prize } = await wonVibe()
    const list = await api('GET', '/admin/prizes?status=AWAITING_ADDRESS', support.accessToken)
    expect(list.statusCode).toBe(200)
    expect(list.json().data.some((p: { id: string; user: { email: string } }) => p.id === prize.id && p.user.email === winner.email)).toBe(true)
    expect((await api('PATCH', `/admin/prizes/${prize.id}`, support.accessToken, { status: 'DELIVERED' })).statusCode).toBe(403)
    // sem endereço confirmado não dá para enviar
    const early = await api('PATCH', `/admin/prizes/${prize.id}`, admin.accessToken, { status: 'SHIPPED', carrier: 'Correios', trackingCode: 'AA123456789BR' })
    expect(early.json().error.code).toBe('PRIZE_INVALID_TRANSITION')
    await api('PUT', `/me/prizes/${prize.id}/address`, winner.accessToken, ADDRESS)
    expect((await api('PATCH', `/admin/prizes/${prize.id}`, admin.accessToken, { status: 'DELIVERED' })).json().error.code).toBe('PRIZE_INVALID_TRANSITION')
    expect((await api('PATCH', `/admin/prizes/${prize.id}`, admin.accessToken, { status: 'SHIPPED' })).statusCode).toBe(400)
    const shipped = await api('PATCH', `/admin/prizes/${prize.id}`, admin.accessToken, { status: 'SHIPPED', carrier: 'Correios', trackingCode: 'AA123456789BR' })
    expect(shipped.statusCode, shipped.body).toBe(200)
    expect(shipped.json().data).toMatchObject({ status: 'SHIPPED', carrier: 'Correios', trackingCode: 'AA123456789BR' })
    const locked = await api('PUT', `/me/prizes/${prize.id}/address`, winner.accessToken, ADDRESS)
    expect(locked.json().error.code).toBe('PRIZE_ALREADY_SHIPPED')
    const fix = await api('PATCH', `/admin/prizes/${prize.id}`, admin.accessToken, { status: 'SHIPPED', carrier: 'Correios', trackingCode: 'BB987654321BR' })
    expect(fix.json().data).toMatchObject({ trackingCode: 'BB987654321BR', shippedAt: shipped.json().data.shippedAt })
    const done = await api('PATCH', `/admin/prizes/${prize.id}`, admin.accessToken, { status: 'DELIVERED' })
    expect(done.json().data.status).toBe('DELIVERED')
    expect(done.json().data.deliveredAt).toBeTruthy()
    const logs = await api('GET', `/admin/audit-logs?entityId=${prize.id}`, admin.accessToken)
    expect(logs.json().data.map((l: { action: string }) => l.action)).toEqual(
      expect.arrayContaining(['PRIZE_ADDRESS_CONFIRMED', 'PRIZE_SHIPPED', 'PRIZE_TRACKING_UPDATED', 'PRIZE_DELIVERED']),
    )
  })

  it('LGPD: prêmio a receber bloqueia a exclusão; depois de entregue exclui e apaga o endereço; exportação traz o prêmio', async () => {
    const { winner, prize } = await wonVibe()
    await api('PUT', `/me/prizes/${prize.id}/address`, winner.accessToken, ADDRESS)
    const exp = await api('GET', '/me/export', winner.accessToken)
    expect(exp.json().prizes[0]).toMatchObject({ id: prize.id, status: 'PREPARING', recipientName: 'Maria Vencedora' })
    const blocked = await api('DELETE', '/me', winner.accessToken, { password: PASSWORD })
    expect(blocked.statusCode).toBe(409)
    expect(blocked.json().error.code).toBe('PRIZE_OPEN')
    await api('PATCH', `/admin/prizes/${prize.id}`, admin.accessToken, { status: 'SHIPPED', carrier: 'Correios', trackingCode: 'CC111222333BR' })
    await api('PATCH', `/admin/prizes/${prize.id}`, admin.accessToken, { status: 'DELIVERED' })
    const del = await api('DELETE', '/me', winner.accessToken, { password: PASSWORD })
    expect(del.statusCode, del.body).toBe(204)
    const [row] = await t.db.select().from(prizeDeliveries).where(eq(prizeDeliveries.id, prize.id))
    expect(row).toMatchObject({ status: 'DELIVERED', recipientName: null, phone: null, cep: null, street: null, trackingCode: 'CC111222333BR' })
  })
})

describe('favoritas', () => {
  it('/me/favorites/vibes lista as Vibes favoritadas no formato da vitrine', async () => {
    const u = await userWithToken(t)
    const { vibe } = await createLiveVibe(t)
    expect((await api('GET', '/me/favorites/vibes', u.accessToken)).json().data).toEqual([])
    expect((await api('PUT', `/me/favorites/${vibe.id}`, u.accessToken)).statusCode).toBe(204)
    const list = (await api('GET', '/me/favorites/vibes', u.accessToken)).json().data
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ id: vibe.id, status: 'LIVE', confirmedGets: 0 })
    expect(list[0].product.name).toBeTruthy()
    expect(list[0].getsCloseAt).toBeTruthy()
    const other = await userWithToken(t)
    expect((await api('GET', '/me/favorites/vibes', other.accessToken)).json().data).toEqual([])
  })
})
