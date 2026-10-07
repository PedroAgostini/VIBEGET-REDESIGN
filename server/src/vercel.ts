import type { IncomingMessage, ServerResponse } from 'node:http'
import { waitUntil } from '@vercel/functions'
import { count, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { buildApp } from './app.js'
import { EnvError, loadEnv } from './config/env.js'
import { createDb } from './db/client.js'
import { encryptLegacyData } from './db/encrypt-legacy.js'
import { products } from './db/schema.js'
import { seed } from './db/seed.js'
import { runScheduledJobs } from './jobs/index.js'
import { configureFieldCryptoFromEnv } from './lib/field-crypto.js'
import { safeErrorForLog } from './lib/log-safety.js'

/**
 * Entrada da API na Vercel (função serverless; ver api/index.js e vercel.json na raiz).
 * Diferenças para o servidor comum (server.ts):
 * - banco: Postgres por DATABASE_URL (sem PGlite: a função não tem disco persistente);
 * - migrações, cifragem do legado e seed rodam na primeira requisição de cada instância, sob advisory lock;
 * - jobs: no máximo um por minuto por instância, depois da resposta (waitUntil), mais o Vercel Cron;
 * - fotos no banco (UPLOAD_STORAGE=db) e limite de upload abaixo dos 4,5 MB da Vercel.
 */

const MIGRATION_LOCK = 727_401
const JOBS_EVERY_MS = 60_000

/** Domínios desta implantação (produção, branch e a URL do deploy) entram na allowlist de CORS/CSRF. */
function vercelOrigins() {
  const own = [process.env.VERCEL_PROJECT_PRODUCTION_URL, process.env.VERCEL_BRANCH_URL, process.env.VERCEL_URL]
    .filter(Boolean)
    .map((host) => `https://${host}`)
  return [process.env.CORS_ORIGINS, ...own].filter(Boolean).join(',')
}

async function boot(): Promise<FastifyInstance> {
  const production = process.env.VERCEL_PROJECT_PRODUCTION_URL
  const env = loadEnv({
    ...process.env,
    CORS_ORIGINS: vercelOrigins(),
    APP_URL: process.env.APP_URL ?? (production ? `https://${production}` : undefined),
    // A Vercel sobrescreve X-Forwarded-For com o IP real do cliente.
    TRUST_PROXY: process.env.TRUST_PROXY ?? 'true',
    UPLOAD_STORAGE: process.env.UPLOAD_STORAGE ?? 'db',
    UPLOAD_MAX_BYTES: process.env.UPLOAD_MAX_BYTES ?? '4000000',
    JOBS_INTERVAL_MS: '0',
  })
  configureFieldCryptoFromEnv(env)

  // Migração numa conexão única e direta (sem o pooler), com lock: duas instâncias frias não migram juntas.
  const direct = await createDb({ databaseUrl: process.env.DATABASE_URL_UNPOOLED ?? env.DATABASE_URL, maxConnections: 1 })
  try {
    await direct.db.execute(sql`SELECT pg_advisory_lock(${MIGRATION_LOCK})`)
    try {
      await direct.migrate()
      await encryptLegacyData(direct.db)
      // Demonstração só na primeira subida (sem nenhum produto) e só com SEED_DEMO=true.
      const [{ n } = { n: 0 }] = await direct.db.select({ n: count() }).from(products)
      const demo = process.env.SEED_DEMO === 'true' && n === 0
      for (const line of await seed(direct.db, { adminEmail: env.SEED_ADMIN_EMAIL, adminPassword: env.SEED_ADMIN_PASSWORD, env, demo, allowDemoInProduction: demo })) {
        console.info(`seed: ${line}`)
      }
    } finally {
      await direct.db.execute(sql`SELECT pg_advisory_unlock(${MIGRATION_LOCK})`)
    }
  } finally {
    await direct.close()
  }

  const handle = await createDb({ databaseUrl: env.DATABASE_URL, maxConnections: 5 })
  const app = await buildApp({ db: handle.db, env })
  for (const w of env.warnings) app.log.warn(w)
  await app.ready()
  return app
}

let ready: Promise<FastifyInstance> | undefined
let lastJobs = 0

function unavailable(res: ServerResponse) {
  res.statusCode = 503
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify({ error: { code: 'UNAVAILABLE', message: 'Serviço indisponível. Tente novamente em instantes.' } }))
}

/**
 * Os rewrites do vercel.json repassam os parâmetros do caminho como query (`?__vgpath=...`).
 * A API valida a query de forma estrita, então eles saem antes de chegar ao Fastify.
 */
function stripRewriteParams(req: IncomingMessage) {
  const raw = req.url ?? '/'
  const q = raw.indexOf('?')
  if (q < 0) return
  const kept = raw
    .slice(q + 1)
    .split('&')
    .filter((pair) => pair && !pair.startsWith('__vg'))
  req.url = raw.slice(0, q) + (kept.length ? `?${kept.join('&')}` : '')
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  stripRewriteParams(req)
  ready ??= boot().catch((err) => {
    ready = undefined // próxima requisição tenta de novo
    throw err
  })
  let app: FastifyInstance
  try {
    app = await ready
  } catch (err) {
    // Configuração inválida aparece no log da Vercel com a lista de variáveis (sem valores).
    console.error(err instanceof EnvError ? err.message : safeErrorForLog(err))
    return unavailable(res)
  }
  if (Date.now() - lastJobs >= JOBS_EVERY_MS) {
    lastJobs = Date.now()
    waitUntil(
      runScheduledJobs(app.ctx).catch((err) => app.log.error({ error: safeErrorForLog(err) }, 'falha nos jobs')),
    )
  }
  app.server.emit('request', req, res)
}
