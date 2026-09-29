import type { DbOrTx } from '../db/client.js'
import { auditLogs } from '../db/schema.js'

export interface AuditEntry {
  actorId?: string | null
  action: string
  entity: string
  entityId?: string | null
  metadata?: Record<string, unknown>
  ip?: string | null
}

/** Registra ação administrativa ou de segurança. Nunca coloque senha/token em metadata. */
export async function audit(db: DbOrTx, entry: AuditEntry): Promise<void> {
  await db.insert(auditLogs).values({
    actorId: entry.actorId ?? null,
    action: entry.action,
    entity: entry.entity,
    entityId: entry.entityId ?? null,
    metadata: entry.metadata ?? null,
    ip: entry.ip ?? null,
  })
}
