import { and, isNotNull, lt, or, sql } from 'drizzle-orm'
import type { DbOrTx } from '../db/client.js'
import { auditLogs, authTokens, sessions } from '../db/schema.js'

/**
 * Retenção de dados pessoais (LGPD, QA-15): guardar só pelo tempo necessário.
 * - audit_logs: o registro do que aconteceu fica (prova e contabilidade); o IP some depois de `ipDays`.
 * - sessions: sessões revogadas ou vencidas há mais de `sessionDays` são apagadas (levam IP e navegador).
 * - auth_tokens: links de e-mail usados ou vencidos há mais de `sessionDays` são apagados.
 */
export interface RetentionPolicy {
  ipDays: number
  sessionDays: number
}

const daysAgo = (now: Date, days: number) => new Date(now.getTime() - days * 24 * 60 * 60 * 1000)

export async function applyRetention(db: DbOrTx, policy: RetentionPolicy, now = new Date()) {
  const ipCutoff = daysAgo(now, policy.ipDays)
  const sessionCutoff = daysAgo(now, policy.sessionDays)

  const ips = await db
    .update(auditLogs)
    .set({ ip: null })
    .where(and(isNotNull(auditLogs.ip), lt(auditLogs.createdAt, ipCutoff)))
    .returning({ id: auditLogs.id })

  const oldSessions = await db
    .delete(sessions)
    // Data em que a sessão deixou de valer: a revogação ou o vencimento, o que vier primeiro.
    .where(lt(sql`least(coalesce(${sessions.revokedAt}, ${sessions.expiresAt}), ${sessions.expiresAt})`, sessionCutoff))
    .returning({ id: sessions.id })

  const oldTokens = await db
    .delete(authTokens)
    .where(or(lt(authTokens.usedAt, sessionCutoff), lt(authTokens.expiresAt, sessionCutoff)))
    .returning({ id: authTokens.id })

  return { auditIpsCleared: ips.length, sessionsDeleted: oldSessions.length, tokensDeleted: oldTokens.length }
}
