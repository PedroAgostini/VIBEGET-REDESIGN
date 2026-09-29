/**
 * QA — /me: perfil, dashboard, mass assignment no PATCH /me.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bearer, createLiveVibe, createTestApp, getUserRow, nextCpf, userWithToken, type TestContext } from './helpers.js'
import { fund, get, placeGet, send } from './qa-helpers.js'

let t: TestContext
beforeAll(async () => {
  t = await createTestApp()
})
afterAll(async () => {
  await t.close()
})

describe('PATCH /me', () => {
  it('altera name, phone, marketingOptIn; gera audit sem valores', async () => {
    const u = await userWithToken(t)
    const res = await send(t, 'PATCH', '/me', { name: '  Joana  Prado ', phone: '+55 11 91234-5678', marketingOptIn: true }, bearer(u.accessToken))
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().user).toMatchObject({ name: 'Joana  Prado', phone: '+5511912345678', marketingOptIn: true })
    const logs = await get(t, `/admin/audit-logs?entityId=${u.id}&action=PROFILE_UPDATED`, (await userWithToken(t, { role: 'ADMIN' })).accessToken)
    expect(logs.json().data[0].metadata).toEqual({ fields: ['name', 'phone', 'marketingOptIn'] })
  })

  it('phone pode ser apagado com null', async () => {
    const u = await userWithToken(t)
    await send(t, 'PATCH', '/me', { phone: '11912345678' }, bearer(u.accessToken))
    const res = await send(t, 'PATCH', '/me', { phone: null }, bearer(u.accessToken))
    expect(res.json().user.phone).toBeNull()
  })

  it.each([
    ['role', { role: 'ADMIN' }],
    ['level', { level: 'VIBER' }],
    ['status', { status: 'ACTIVE' }],
    ['email', { email: 'novo@x.dev' }],
    ['emailVerified', { emailVerified: true }],
    ['emailVerifiedAt', { emailVerifiedAt: new Date().toISOString() }],
    ['passwordHash', { passwordHash: 'x' }],
    ['referralCode', { referralCode: 'AAAAAAAA' }],
    ['balanceCents', { balanceCents: 999999 }],
    ['id', { id: '00000000-0000-4000-8000-000000000000' }],
  ])('mass assignment: %s → 400 e nada muda', async (_f, body) => {
    const u = await userWithToken(t)
    const before = await getUserRow(t, u.id)
    const res = await send(t, 'PATCH', '/me', { name: 'Nome Novo', ...body }, bearer(u.accessToken))
    expect(res.statusCode).toBe(400)
    const after = await getUserRow(t, u.id)
    expect(after.name).toBe(before.name)
    expect(after.role).toBe(before.role)
    expect(after.email).toBe(before.email)
  })

  it('CPF: pode ser definido se vazio; não pode ser trocado depois (409 CPF_LOCKED); reenviar o mesmo é ok', async () => {
    const u = await userWithToken(t, { cpf: null })
    const cpf = nextCpf()
    const masked = `${cpf.slice(0, 3)}.${cpf.slice(3, 6)}.${cpf.slice(6, 9)}-${cpf.slice(9)}`
    const r1 = await send(t, 'PATCH', '/me', { cpf: masked }, bearer(u.accessToken))
    expect(r1.statusCode, r1.body).toBe(200)
    expect(r1.json().user.hasCpf).toBe(true)
    expect(r1.body).not.toContain(cpf)
    expect((await send(t, 'PATCH', '/me', { cpf }, bearer(u.accessToken))).statusCode).toBe(200)
    const r2 = await send(t, 'PATCH', '/me', { cpf: nextCpf() }, bearer(u.accessToken))
    expect(r2.statusCode).toBe(409)
    expect(r2.json().error.code).toBe('CPF_LOCKED')
  })

  it('CPF já usado por outra conta → 409 CPF_TAKEN; CPF inválido → 400', async () => {
    const a = await userWithToken(t)
    const b = await userWithToken(t, { cpf: null })
    const aCpf = (await getUserRow(t, a.id)).cpf!
    const res = await send(t, 'PATCH', '/me', { cpf: aCpf }, bearer(b.accessToken))
    expect(res.statusCode).toBe(409)
    expect(res.json().error.code).toBe('CPF_TAKEN')
    expect((await send(t, 'PATCH', '/me', { cpf: '12345678900' }, bearer(b.accessToken))).statusCode).toBe(400)
  })

  it('birthDate: definível se vazio; troca → 409 BIRTHDATE_LOCKED (impede burlar 18+)', async () => {
    const u = await userWithToken(t, { birthDate: null })
    expect((await send(t, 'PATCH', '/me', { birthDate: '2015-01-01' }, bearer(u.accessToken))).statusCode).toBe(200)
    const r = await send(t, 'PATCH', '/me', { birthDate: '1990-01-01' }, bearer(u.accessToken))
    expect(r.statusCode).toBe(409)
    expect(r.json().error.code).toBe('BIRTHDATE_LOCKED')
  })

  it('corpo vazio devolve o perfil sem alterar', async () => {
    const u = await userWithToken(t)
    const res = await send(t, 'PATCH', '/me', {}, bearer(u.accessToken))
    expect(res.statusCode).toBe(200)
    expect(res.json().user.id).toBe(u.id)
  })
})

describe('GET /me/dashboard e /me/wallet', () => {
  it('dashboard: nível, saldo, Gets ativos, vitórias, últimas movimentações; nada sensível', async () => {
    const { vibe } = await createLiveVibe(t)
    const u = await userWithToken(t)
    await fund(t, u.id, 700)
    await placeGet(t, u.accessToken, vibe.id, { cashCents: 500, getcoinCents: 200 })
    const res = await get(t, '/me/dashboard', u.accessToken)
    expect(res.statusCode).toBe(200)
    const d = res.json().data
    expect(d).toMatchObject({ level: 'EXPLORADOR', balanceCents: 500, wins: 0, cashbackReceivedCents: 0 })
    expect(d.activeGets).toHaveLength(1)
    expect(d.recentMovements.map((m: { type: string }) => m.type)).toEqual(['SPEND_ON_GET', 'ADJUSTMENT'])
    expect(res.body).not.toMatch(/passwordHash|failedLoginCount|lockedUntil|idempotency/i)
  })

  it('wallet: paginação e validação de query', async () => {
    const u = await userWithToken(t)
    for (let i = 0; i < 3; i++) await fund(t, u.id, 10)
    const res = await get(t, '/me/wallet?page=2&pageSize=2', u.accessToken)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ balanceCents: 30, meta: { page: 2, pageSize: 2, total: 3 } })
    expect(res.json().data).toHaveLength(1)
    expect((await get(t, '/me/wallet?pageSize=101', u.accessToken)).statusCode).toBe(400)
    expect((await get(t, '/me/wallet?page=0', u.accessToken)).statusCode).toBe(400)
  })
})
