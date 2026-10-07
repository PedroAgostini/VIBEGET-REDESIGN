import { loadEnv } from '../config/env.js'
import { configureFieldCryptoFromEnv } from '../lib/field-crypto.js'
import { createDb, MIGRATIONS_FOLDER } from './client.js'
import { encryptLegacyData } from './encrypt-legacy.js'

/** Aplica as migrações versionadas de ./drizzle (PGlite em PGLITE_DATA_DIR se DATABASE_URL vazio) e cifra o legado. */
async function main() {
  const env = loadEnv()
  configureFieldCryptoFromEnv(env)
  const handle = await createDb({ databaseUrl: env.DATABASE_URL, pgliteDataDir: env.PGLITE_DATA_DIR })
  try {
    await handle.migrate()
    const { updated } = await encryptLegacyData(handle.db)
    console.info(`migrações aplicadas (${handle.kind}) a partir de ${MIGRATIONS_FOLDER}; ${updated} registro(s) cifrado(s)`)
  } finally {
    await handle.close()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
