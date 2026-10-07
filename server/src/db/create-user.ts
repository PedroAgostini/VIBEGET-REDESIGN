import { buildApp } from '../app.js'
import { loadEnv } from '../config/env.js'
import { MemoryMailer } from '../lib/mailer.js'
import { createDb } from './client.js'

/**
 * Ferramenta de DESENVOLVIMENTO: cria um usuário pelo fluxo real de cadastro (mesmas regras,
 * carteira, código de indicação) e já confirma o e-mail pelo token do link de verificação.
 *   NEW_PASSWORD='...' npm run user:create -- email@exemplo.com "Nome Completo"
 * Roda a aplicação em processo (app.inject), sem abrir porta. Com PGlite, pare a API antes.
 * Fecha a aplicação e o banco de forma limpa: matar o processo no meio de uma gravação corrompe o PGlite.
 */
async function main() {
  const env = loadEnv()
  if (env.NODE_ENV !== 'development' && env.NODE_ENV !== 'test') {
    throw new Error('Recusado: esta ferramenta só roda com NODE_ENV=development ou test.')
  }
  const [email, name] = process.argv.slice(2)
  const password = process.env.NEW_PASSWORD ?? ''
  if (!email || !name) throw new Error('Uso: npm run user:create -- email@exemplo.com "Nome Completo"')

  const handle = await createDb({ databaseUrl: env.DATABASE_URL, pgliteDataDir: env.PGLITE_DATA_DIR })
  const mailer = new MemoryMailer()
  const app = await buildApp({ db: handle.db, env, mailer, logger: false, rateLimit: false })
  try {
    const headers = { 'x-requested-with': 'fetch', origin: env.CORS_ORIGINS[0] ?? 'http://localhost:5173' }
    const reg = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      headers,
      payload: { name, email, password, acceptTerms: true },
    })
    if (reg.statusCode !== 201) throw new Error(`Cadastro recusado (${reg.statusCode}): ${reg.body}`)

    const token = mailer.last('EMAIL_VERIFY', email.trim().toLowerCase())?.token
    if (!token) throw new Error('Token de verificação não foi gerado.')
    const ver = await app.inject({ method: 'POST', url: '/api/v1/auth/verify-email', headers, payload: { token } })
    if (ver.statusCode >= 300) throw new Error(`Verificação recusada (${ver.statusCode}): ${ver.body}`)

    console.info(`usuário criado e e-mail confirmado: ${email} (${handle.kind})`)
  } finally {
    await app.close()
    await handle.close()
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
