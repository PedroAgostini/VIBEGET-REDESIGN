/**
 * QA — LGPD: exportação e exclusão por anonimização.
 */
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { authTokens, gets, sessions, users } from '../src/db/schema.js'
import { bearer, createLiveVibe, createTestApp, CSRF, getUserRow, login, userWithToken, type TestContext } from './helpers.js'
import { assertLedgerInvariant, confirmedGet, fund, get, placeGet, send } from './qa-helpers.js'

let t: TestContext
beforeAll(async () => {
  t = await createTestApp()
})
afterAll(async () => {
  await t.close()
})

describe('GET /me/export', () => {
  it('traz perfil completo (com CPF), carteira, Gets, pagamentos, sessões e atividade do titular; sem hashes nem dados de terceiros', async () => {
    const { vibe } = await createLiveVibe(t)
    const a = await userWithToken(t, { name: 'Titular Um' })
    const b = await userWithToken(t, { name: 'Terceiro Dois' })
    await fund(t, a.id, 300)
    await fund(t, b.id, 300)
    await placeGet(t, a.accessToken, vibe.id, { cashCents: 500, getcoinCents: 100 })
    const bGet = await confirmedGet(t, b.accessToken, vibe.id, { cashCents: 900 })

    const res = await get(t, '/me/export', a.accessToken)
    expect(res.statusCode).toBe(200)
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.headers['content-disposition']).toMatch(/attachment/)
    const d = res.json()
    const row = await getUserRow(t, a.id)
    expect(d.profile).toMatchObject({ id: a.id, email: a.email, cpf: row.cpf, name: 'Titular Um' })
    expect(d.wallet.balanceCents).toBe(200)
    expect(d.wallet.ledger).toHaveLength(2)
    expect(d.gets).toHaveLength(1)
    expect(d.payments).toHaveLength(1)
    expect(d.sessions.length).toBeGreaterThanOrEqual(1)
    expect(d.activity.map((x: { action: string }) => x.action)).toContain('LOGIN_SUCCEEDED')

    const raw = res.body
    expect(raw).not.toMatch(/passwordHash|password_hash|tokenHash|token_hash|argon2|idempotencyKey|externalId/)
    expect(raw).not.toContain(b.id)
    expect(raw).not.toContain(b.email)
    expect(raw).not.toContain('Terceiro')
    expect(raw).not.toContain(bGet)
  })

  it('exige login', async () => {
    expect((await get(t, '/me/export')).statusCode).toBe(401)
  })
})

describe('DELETE /me', () => {
  it('senha errada → 400 e nada muda; sem senha → 400', async () => {
    const u = await userWithToken(t)
    expect((await send(t, 'DELETE', '/me', { password: 'errada-errada' }, bearer(u.accessToken))).statusCode).toBe(400)
    expect((await send(t, 'DELETE', '/me', {}, bearer(u.accessToken))).statusCode).toBe(400)
    expect((await getUserRow(t, u.id)).status).toBe('ACTIVE')
  })

  it('anonimiza dados pessoais, revoga sessões, apaga tokens, limpa IP/UA das sessões e mantém registros financeiros', async () => {
    const { vibe } = await createLiveVibe(t)
    const u = await userWithToken(t)
    const other = await login(t, u.email)
    await fund(t, u.id, 100)
    await send(t, 'POST', '/auth/forgot-password', { email: u.email })
    const gId = await confirmedGet(t, u.accessToken, vibe.id, { cashCents: 500 })
    // D13: outro usuário vence; se `u` vencesse, o prêmio a receber também bloquearia a exclusão (PRIZE_OPEN).
    const rival = await userWithToken(t)
    await confirmedGet(t, rival.accessToken, vibe.id, { cashCents: 900 })
    // Get em Vibe LIVE bloqueia a exclusão
    const blocked = await send(t, 'DELETE', '/me', { password: u.password }, bearer(u.accessToken))
    expect(blocked.statusCode).toBe(409)
    expect(blocked.json().error.code).toBe('OPEN_GETS')
    await send(t, 'POST', `/admin/vibes/${vibe.id}/close`, undefined, bearer((await userWithToken(t, { role: 'ADMIN' })).accessToken))

    const res = await send(t, 'DELETE', '/me', { password: u.password }, bearer(u.accessToken))
    expect(res.statusCode, res.body).toBe(204)
    const row = await getUserRow(t, u.id)
    expect(row).toMatchObject({ status: 'DELETED', cpf: null, phone: null, birthDate: null, marketingOptIn: false, name: 'Conta excluída' })
    expect(row.email).not.toBe(u.email)
    expect(row.email).toMatch(/@deleted\.invalid$/)
    expect(row.deletedAt).toBeInstanceOf(Date)
    const ss = await t.db.select().from(sessions).where(eq(sessions.userId, u.id))
    expect(ss.every((s) => s.revokedAt && s.ip === null && s.userAgent === null)).toBe(true)
    expect(await t.db.select().from(authTokens).where(eq(authTokens.userId, u.id))).toHaveLength(0)
    expect((await get(t, '/auth/me', u.accessToken)).statusCode).toBe(401)
    expect((await get(t, '/auth/me', other.accessToken)).statusCode).toBe(401)
    expect((await send(t, 'POST', '/auth/login', { email: u.email, password: u.password }, CSRF)).statusCode).toBe(401)
    // financeiro preservado
    expect(await t.db.select().from(gets).where(eq(gets.id, gId))).toHaveLength(1)
    await assertLedgerInvariant(t)
  })

  it('e-mail e CPF ficam livres para um novo cadastro', async () => {
    const u = await userWithToken(t)
    const cpf = (await getUserRow(t, u.id)).cpf!
    expect((await send(t, 'DELETE', '/me', { password: u.password }, bearer(u.accessToken))).statusCode).toBe(204)
    const reg = await send(
      t,
      'POST',
      '/auth/register',
      { name: 'Nova Pessoa', email: u.email, password: 'Senha-Nova-Forte-2026', cpf, acceptTerms: true },
      CSRF,
    )
    expect(reg.statusCode, reg.body).toBe(201)
    expect(reg.json().user.id).not.toBe(u.id)
  })

  it('exibição pública de Get de conta excluída não expõe dados antigos', async () => {
    const { vibe } = await createLiveVibe(t)
    const u = await userWithToken(t, { name: 'Fulano Deletado' })
    await confirmedGet(t, u.accessToken, vibe.id, { cashCents: 777 })
    await t.db.update(users).set({ name: 'Conta excluída', status: 'DELETED' }).where(eq(users.id, u.id))
    const pub = await get(t, `/vibes/${vibe.slug}`)
    expect(pub.body).not.toContain('Fulano')
  })
})
