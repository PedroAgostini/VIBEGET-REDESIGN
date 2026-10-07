import { buildApp } from './app.js'
import { EnvError, loadEnv } from './config/env.js'
import { createDb } from './db/client.js'
import { encryptLegacyData } from './db/encrypt-legacy.js'
import { configureFieldCryptoFromEnv } from './lib/field-crypto.js'
import { startJobs } from './jobs/index.js'

async function main() {
  let env
  try {
    env = loadEnv()
  } catch (err) {
    if (err instanceof EnvError) {
      console.error(err.message)
      process.exit(1)
    }
    throw err
  }

  configureFieldCryptoFromEnv(env)
  const handle = await createDb({ databaseUrl: env.DATABASE_URL, pgliteDataDir: env.PGLITE_DATA_DIR })
  if (env.AUTO_MIGRATE && handle.kind === 'pglite') {
    // Em dev com PGlite aplicamos as migrações no boot (o diretório não pode ser aberto por 2 processos).
    await handle.migrate()
  }
  // Cifra o que ainda estiver em texto puro (ou com chave antiga). Idempotente e barato quando não há pendências.
  const { updated } = await encryptLegacyData(handle.db)
  if (updated) console.info(`criptografia: ${updated} registro(s) cifrado(s) agora`)

  const app = await buildApp({ db: handle.db, env })
  for (const w of env.warnings) app.log.warn(w)
  const stopJobs = startJobs(app.ctx, env.JOBS_INTERVAL_MS)

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'encerrando')
    stopJobs()
    await app.close()
    await handle.close()
    process.exit(0)
  }
  process.once('SIGINT', () => void shutdown('SIGINT'))
  process.once('SIGTERM', () => void shutdown('SIGTERM'))

  await app.listen({ host: env.HOST, port: env.PORT })
  app.log.info(`banco: ${handle.kind}${handle.kind === 'pglite' ? ` (${env.PGLITE_DATA_DIR})` : ''}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
