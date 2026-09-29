import { loadEnv } from '../config/env.js'
import { createDb, MIGRATIONS_FOLDER } from './client.js'

/** Aplica as migrações versionadas de ./drizzle (PGlite em PGLITE_DATA_DIR se DATABASE_URL vazio). */
async function main() {
  const env = loadEnv()
  const handle = await createDb({ databaseUrl: env.DATABASE_URL, pgliteDataDir: env.PGLITE_DATA_DIR })
  try {
    await handle.migrate()
    console.info(`migrações aplicadas (${handle.kind}) a partir de ${MIGRATIONS_FOLDER}`)
  } finally {
    await handle.close()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
