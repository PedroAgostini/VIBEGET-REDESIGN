/**
 * QA — carteira GetCoin: ajustes administrativos, livro-razão e invariantes.
 */
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { auditLogs, getcoinLedger } from '../src/db/schema.js'
import { applyWalletMovement, moveGetcoin } from '../src/modules/wallet/service.js'
import { bearer, createTestApp, createUser, userWithToken, type TestContext } from './helpers.js'
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

const adjust = (userId: string, body: unknown, token = admin.accessToken) =>
  send(t, 'POST', `/admin/users/${userId}/wallet-adjustments`, body, bearer(token))

describe('POST /admin/users/:id/wallet-adjustments', () => {
  it('crédito e débito geram ADJUSTMENT com created_by e motivo; saldo e balance_after corretos; audit WALLET_ADJUSTED', async () => {
    const u = await createUser(t)
    const c = await adjust(u.id, { amountCents: 1500, reason: 'Compensação de suporte' })
    expect(c.statusCode, c.body).toBe(201)
    expect(c.json().data).toMatchObject({ balanceCents: 1500, ledgerEntry: { type: 'ADJUSTMENT', amountCents: 1500, balanceAfterCents: 1500 } })
    const d = await adjust(u.id, { amountCents: -500, reason: 'Estorno de bônus' })
    expect(d.json().data.balanceCents).toBe(1000)
    const rows = await t.db.select().from(getcoinLedger).where(eq(getcoinLedger.userId, u.id))
    expect(rows.every((r) => r.createdById === admin.id && r.reason)).toBe(true)
    const logs = await t.db.select().from(auditLogs).where(and(eq(auditLogs.entityId, u.id), eq(auditLogs.action, 'WALLET_ADJUSTED')))
    expect(logs).toHaveLength(2)
    expect(logs[0]!.actorId).toBe(admin.id)
  })

  it('débito maior que o saldo → 422 INSUFFICIENT_GETCOIN e nada gravado', async () => {
    const u = await createUser(t)
    await adjust(u.id, { amountCents: 100, reason: 'saldo inicial' })
    const res = await adjust(u.id, { amountCents: -101, reason: 'tentativa de negativar' })
    expect(res.statusCode).toBe(422)
    expect(await balanceOf(t, u.id)).toBe(100)
    expect(await t.db.select().from(getcoinLedger).where(eq(getcoinLedger.userId, u.id))).toHaveLength(1)
  })

  it.each([
    ['sem motivo', { amountCents: 100 }],
    ['motivo curto', { amountCents: 100, reason: 'ok' }],
    ['valor zero', { amountCents: 0, reason: 'motivo válido' }],
    ['valor fracionado', { amountCents: 1.5, reason: 'motivo válido' }],
    ['valor absurdo', { amountCents: 10_000_001, reason: 'motivo válido' }],
    ['campo extra type', { amountCents: 100, reason: 'motivo válido', type: 'CASHBACK' }],
  ])('%s → 400', async (_l, body) => {
    const u = await createUser(t)
    expect((await adjust(u.id, body)).statusCode).toBe(400)
  })

  it('ADMIN não ajusta a própria carteira (403); usuário inexistente → 404; conta excluída → 409', async () => {
    expect((await adjust(admin.id, { amountCents: 100, reason: 'auto crédito' })).statusCode).toBe(403)
    expect((await adjust('00000000-0000-4000-8000-000000000000', { amountCents: 100, reason: 'motivo válido' })).statusCode).toBe(404)
    const u = await userWithToken(t)
    await send(t, 'DELETE', '/me', { password: u.password }, bearer(u.accessToken))
    expect((await adjust(u.id, { amountCents: 100, reason: 'motivo válido' })).statusCode).toBe(409)
  })

  it('SUPPORT não ajusta carteira', async () => {
    const s = await userWithToken(t, { role: 'SUPPORT' })
    const u = await createUser(t)
    expect((await adjust(u.id, { amountCents: 100, reason: 'motivo válido' }, s.accessToken)).statusCode).toBe(403)
  })

  it('saldo aparece em GET /admin/users/:id', async () => {
    const u = await createUser(t)
    await adjust(u.id, { amountCents: 250, reason: 'motivo válido' })
    const res = await get(t, `/admin/users/${u.id}`, admin.accessToken)
    expect(res.json().data).toMatchObject({ balanceCents: 250, getsCount: 0, wins: 0 })
  })
})

describe('applyWalletMovement (serviço)', () => {
  it('recusa valor zero e não-inteiro; carteira inexistente → 404', async () => {
    const u = await createUser(t)
    await expect(moveGetcoin(t.db, { userId: u.id, amountCents: 0, type: 'ADJUSTMENT' })).rejects.toThrow()
    await expect(moveGetcoin(t.db, { userId: u.id, amountCents: 1.5, type: 'ADJUSTMENT' })).rejects.toThrow()
    await expect(
      t.db.transaction((tx) => applyWalletMovement(tx, { userId: '00000000-0000-4000-8000-000000000000', amountCents: 1, type: 'ADJUSTMENT' })),
    ).rejects.toMatchObject({ statusCode: 404 })
  })

  it('movimentos concorrentes (20 débitos de 10 com saldo 100) nunca negativam', async () => {
    const u = await createUser(t)
    await moveGetcoin(t.db, { userId: u.id, amountCents: 100, type: 'ADJUSTMENT' })
    const rs = await Promise.allSettled(
      Array.from({ length: 20 }, () => moveGetcoin(t.db, { userId: u.id, amountCents: -10, type: 'ADJUSTMENT' })),
    )
    expect(rs.filter((r) => r.status === 'fulfilled')).toHaveLength(10)
    expect(await balanceOf(t, u.id)).toBe(0)
    await assertLedgerInvariant(t)
  })
})
