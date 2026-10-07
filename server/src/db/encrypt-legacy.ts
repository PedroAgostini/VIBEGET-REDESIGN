import { sql, type SQL } from 'drizzle-orm'
import { cpfIndex, currentKeyId, decryptField, emailIndex, encryptField } from '../lib/field-crypto.js'
import type { Db } from './client.js'

/**
 * Cifra os dados pessoais gravados antes da criptografia (ou com uma chave antiga) e preenche
 * os índices cegos. Roda logo depois das migrações; é idempotente e só toca nas linhas pendentes.
 * Lê e grava em SQL puro (sem o tipo cifrado do schema) para ver o valor como está no banco.
 */

const TABLES: Record<string, string[]> = {
  users: ['email', 'cpf', 'phone', 'birth_date', 'cep', 'street', 'number', 'complement', 'district', 'city'],
  sessions: ['ip', 'user_agent'],
  audit_logs: ['ip'],
  withdrawals: ['pix_key'],
  prize_deliveries: ['recipient_name', 'phone', 'cep', 'street', 'number', 'complement', 'district', 'city'],
}

type Row = Record<string, string | null> & { id: string }
const rowsOf = (r: unknown) => (r as { rows: Row[] }).rows

export async function encryptLegacyData(db: Db): Promise<{ updated: number }> {
  const prefix = `enc:${currentKeyId()}:`
  let updated = 0

  for (const [table, cols] of Object.entries(TABLES)) {
    const extra = table === 'users' ? ['email_hash', 'cpf_hash'] : []
    const pending: SQL[] = cols.map((c) => sql`(${sql.identifier(c)} IS NOT NULL AND ${sql.identifier(c)} NOT LIKE ${`${prefix}%`})`)
    if (table === 'users') pending.push(sql`email_hash IS NULL`, sql`(cpf IS NOT NULL AND cpf_hash IS NULL)`)
    const select = sql.join([...cols, ...extra].map((c) => sql.identifier(c)), sql`, `)
    const rows = rowsOf(
      await db.execute(sql`SELECT id, ${select} FROM ${sql.identifier(table)} WHERE ${sql.join(pending, sql` OR `)}`),
    )

    for (const row of rows) {
      const set: SQL[] = []
      for (const c of cols) {
        const raw = row[c]
        if (raw == null || raw.startsWith(prefix)) continue
        set.push(sql`${sql.identifier(c)} = ${encryptField(decryptField(raw))}`)
      }
      if (table === 'users') {
        const email = row.email == null ? null : decryptField(row.email)
        const cpf = row.cpf == null ? null : decryptField(row.cpf)
        if (email != null) set.push(sql`email_hash = ${emailIndex(email)}`)
        set.push(sql`cpf_hash = ${cpf == null ? null : cpfIndex(cpf)}`)
      }
      if (!set.length) continue
      await db.execute(sql`UPDATE ${sql.identifier(table)} SET ${sql.join(set, sql`, `)} WHERE id = ${row.id}`)
      updated++
    }
  }

  // Com todas as linhas preenchidas, as regras que dependem dos hashes passam a valer no banco
  // (só quando ainda faltam: ALTER TABLE trava a tabela, e isto roda em toda subida).
  const [col] = rowsOf(
    await db.execute(sql`SELECT is_nullable AS id FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'email_hash'`),
  )
  if (col?.id === 'YES') await db.execute(sql`ALTER TABLE users ALTER COLUMN email_hash SET NOT NULL`)
  await db.execute(sql`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_cpf_hash_ck') THEN
        ALTER TABLE users ADD CONSTRAINT users_cpf_hash_ck CHECK ((cpf IS NULL) = (cpf_hash IS NULL));
      END IF;
    END $$`)
  return { updated }
}
