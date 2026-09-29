import { eq } from 'drizzle-orm'
import { loadEnv } from '../config/env.js'
import { hashPassword } from '../lib/crypto.js'
import { emailSchema, passwordSchema } from '../modules/auth/schemas.js'
import { revokeAllSessions } from '../modules/auth/service.js'
import { createDb } from './client.js'
import { users } from './schema.js'

/**
 * Ferramenta de DESENVOLVIMENTO: define a senha de um usuário existente.
 *   NEW_PASSWORD='...' npm run user:set-password -- email@exemplo.com
 * A senha vem só da variável de ambiente (nunca do argv, que aparece na lista de processos).
 * Aplica a mesma regra de senha do cadastro, revoga todas as sessões e zera o bloqueio por tentativas.
 * Com PGlite, pare a API antes (o diretório não pode ser aberto por dois processos).
 */
async function main() {
  const env = loadEnv()
  if (env.NODE_ENV !== 'development' && env.NODE_ENV !== 'test') {
    throw new Error('Recusado: esta ferramenta só roda com NODE_ENV=development ou test.')
  }
  const email = emailSchema.parse(process.argv[2] ?? '')
  const password = process.env.NEW_PASSWORD ?? ''
  const check = passwordSchema.safeParse(password)
  if (!check.success) throw new Error(`Senha recusada: ${check.error.issues.map((i) => i.message).join(' ')}`)
  if (password.toLowerCase() === email) throw new Error('Senha recusada: não pode ser igual ao e-mail.')

  const handle = await createDb({ databaseUrl: env.DATABASE_URL, pgliteDataDir: env.PGLITE_DATA_DIR })
  try {
    const [user] = await handle.db.select({ id: users.id, status: users.status }).from(users).where(eq(users.email, email))
    if (!user) throw new Error(`Usuário não encontrado: ${email}`)
    if (user.status === 'DELETED') throw new Error('Conta excluída; não é possível definir senha.')
    const passwordHash = await hashPassword(password)
    await handle.db.transaction(async (tx) => {
      await tx.update(users).set({ passwordHash, failedLoginCount: 0, lockedUntil: null }).where(eq(users.id, user.id))
      await revokeAllSessions(tx, user.id)
    })
    console.info(`senha alterada para ${email}; sessões revogadas (${handle.kind})`)
  } finally {
    await handle.close()
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
