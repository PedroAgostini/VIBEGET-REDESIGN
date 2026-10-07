import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { auditLogs, sessions } from '../src/db/schema.js'
import { applyRetention } from '../src/lib/retention.js'
import { bearer, createTestApp, userWithToken, type TestContext } from './helpers.js'

/** LGPD (QA-15): IP da auditoria, sessões e links de e-mail não ficam guardados para sempre. */

let t: TestContext
beforeAll(async () => {
  t = await createTestApp()
})
afterAll(async () => {
  await t.close()
})

const DAY = 24 * 60 * 60 * 1000
const policy = { ipDays: 180, sessionDays: 30 }

describe('retenção de dados pessoais', () => {
  it('apaga o IP de auditoria antiga (o registro fica), sessões encerradas antigas e links de e-mail velhos; o recente fica', async () => {
    const now = new Date()
    const u = await userWithToken(t)
    const [oldLog] = await t.db
      .insert(auditLogs)
      .values({ actorId: u.id, action: 'LOGIN_SUCCEEDED', entity: 'user', entityId: u.id, ip: '10.0.0.1', createdAt: new Date(now.getTime() - 200 * DAY) })
      .returning()
    const [newLog] = await t.db
      .insert(auditLogs)
      .values({ actorId: u.id, action: 'LOGIN_SUCCEEDED', entity: 'user', entityId: u.id, ip: '10.0.0.2', createdAt: new Date(now.getTime() - 10 * DAY) })
      .returning()

    // A sessão do login vira "revogada há 40 dias"; outra sessão nova continua ativa.
    const [first] = await t.db.select().from(sessions).where(eq(sessions.userId, u.id))
    await t.db.update(sessions).set({ revokedAt: new Date(now.getTime() - 40 * DAY) }).where(eq(sessions.id, first!.id))
    const active = await userWithToken(t)
    await t.db.execute(sql`INSERT INTO auth_tokens (id, user_id, type, token_hash, expires_at, used_at)
      VALUES (gen_random_uuid(), ${u.id}, 'EMAIL_VERIFY', ${'x'.repeat(64)}, ${new Date(now.getTime() - 60 * DAY).toISOString()}, null)`)

    const r = await applyRetention(t.db, policy, now)
    expect(r.auditIpsCleared).toBeGreaterThanOrEqual(1)
    expect(r.sessionsDeleted).toBeGreaterThanOrEqual(1)
    expect(r.tokensDeleted).toBeGreaterThanOrEqual(1)

    const [o] = await t.db.select().from(auditLogs).where(eq(auditLogs.id, oldLog!.id))
    const [n] = await t.db.select().from(auditLogs).where(eq(auditLogs.id, newLog!.id))
    expect(o).toMatchObject({ action: 'LOGIN_SUCCEEDED', ip: null }) // o fato fica, o IP sai
    expect(n!.ip).toBe('10.0.0.2')
    expect(await t.db.select().from(sessions).where(eq(sessions.id, first!.id))).toHaveLength(0)
    // a sessão ativa de outra pessoa continua funcionando
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: bearer(active.accessToken) })).statusCode).toBe(200)

    // idempotente: rodar de novo não apaga mais nada do que ficou
    expect(await applyRetention(t.db, policy, now)).toEqual({ auditIpsCleared: 0, sessionsDeleted: 0, tokensDeleted: 0 })
  })
})
