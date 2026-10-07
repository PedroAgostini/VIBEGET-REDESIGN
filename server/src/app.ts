import cookie from '@fastify/cookie'
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify'
import { loadEnv, type Env } from './config/env.js'
import type { AppContext } from './context.js'
import type { Db } from './db/client.js'
import { configureFieldCryptoFromEnv } from './lib/field-crypto.js'
import { logCensor } from './lib/log-safety.js'
import { SettingsStore } from './lib/settings.js'
import { ConsoleMailer, type Mailer } from './lib/mailer.js'
import adminRoutes from './modules/admin/routes.js'
import authRoutes from './modules/auth/routes.js'
import couponRoutes from './modules/coupons/routes.js'
import addressRoutes from './modules/address/routes.js'
import marketRoutes from './modules/market/routes.js'
import purchaseRoutes from './modules/purchases/routes.js'
import withdrawalRoutes from './modules/withdrawals/routes.js'
import { adminUploadRoutes, publicUploadRoutes } from './modules/uploads/routes.js'
import getRoutes from './modules/gets/routes.js'
import meRoutes from './modules/me/routes.js'
import paymentRoutes from './modules/payments/routes.js'
import vibeRoutes from './modules/vibes/routes.js'
import prizeRoutes from './modules/prizes/routes.js'
import internalRoutes from './modules/internal/routes.js'
import authPlugin from './plugins/auth.js'
import errorsPlugin from './plugins/errors.js'
import securityPlugin from './plugins/security.js'

export interface BuildAppOptions {
  db: Db
  env?: Env
  mailer?: Mailer
  /** true = logger pino com redact; false = silencioso (testes). */
  logger?: boolean
  /** Desliga rate limit (útil em testes que não testam o limite). Padrão: ligado. */
  rateLimit?: boolean
  /** HTTP de saída (proxy de CEP); padrão: fetch global. */
  fetch?: AppContext['fetch']
  /** Recebe cada rota registrada (testes: matriz de acesso de todas as rotas). */
  onRoute?: (route: { method: string | string[]; url: string }) => void
}

export const API_PREFIX = '/api/v1'

/** Chaves que nunca podem aparecer em log. */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-signature"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.currentPassword',
  '*.newPassword',
  '*.passwordHash',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.tokenHash',
  '*.cpf',
  '*.pixKey',
  // Erros de banco: query, parâmetros e detalhes com valores nunca vão para o log (QA-04)
  'err.message',
  'err.stack',
  'err.query',
  'err.params',
  'err.detail',
  'err.where',
  'err.internalQuery',
  'err.cause',
]

const hopsTrust = (n: number) => (_addr: string, hop: number) => hop < n

/** Fábrica testável: recebe o banco pronto (migrado) e devolve a app sem abrir porta. */
export async function buildApp(opts: BuildAppOptions): Promise<FastifyInstance> {
  const env = opts.env ?? loadEnv()
  // Dados pessoais são cifrados no banco (LGPD); sem a chave nada é lido nem gravado.
  configureFieldCryptoFromEnv(env)
  const loggerOpts: FastifyServerOptions['logger'] =
    opts.logger === false
      ? false
      : {
          level: env.LOG_LEVEL,
          redact: { paths: REDACT_PATHS, censor: logCensor },
          ...(env.isProduction ? {} : { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss' } } }),
        }

  const app = Fastify({
    logger: loggerOpts,
    bodyLimit: 64 * 1024,
    // número N = confia nos N saltos mais próximos (mesma semântica do proxy-addr)
    trustProxy: typeof env.TRUST_PROXY === 'number' ? hopsTrust(env.TRUST_PROXY) : env.TRUST_PROXY,
    routerOptions: { ignoreTrailingSlash: true, maxParamLength: 200 },
  })

  const ctx: AppContext = {
    db: opts.db,
    env,
    // Em produção o link (com token) não vai para o log, a menos que MAIL_LOG_LINKS esteja ligado (só testes).
    mailer: opts.mailer ?? new ConsoleMailer(app.log, env.isProduction && !env.MAIL_LOG_LINKS),
    settings: new SettingsStore(opts.db, env, app.log),
    fetch: opts.fetch ?? ((url, init) => globalThis.fetch(url, init)),
    log: app.log,
    signAccessToken: () => {
      throw new Error('auth plugin não registrado')
    },
  }
  app.decorate('ctx', ctx)
  if (opts.onRoute) {
    const collect = opts.onRoute
    app.addHook('onRoute', (r) => collect({ method: r.method, url: r.url }))
  }
  app.decorateRequest('receivedAt', 0)
  app.addHook('onRequest', async (req) => {
    req.receivedAt = Date.now()
  })

  await app.register(errorsPlugin)
  await app.register(securityPlugin, { rateLimit: opts.rateLimit ?? true })
  await app.register(cookie)
  await app.register(authPlugin)

  await app.register(
    async (api) => {
      api.get('/health', async () => ({ status: 'ok', time: new Date().toISOString() }))
      await api.register(authRoutes)
      await api.register(vibeRoutes)
      await api.register(getRoutes)
      await api.register(paymentRoutes)
      await api.register(meRoutes)
      await api.register(adminRoutes)
      await api.register(couponRoutes)
      await api.register(adminUploadRoutes)
      await api.register(purchaseRoutes)
      await api.register(withdrawalRoutes)
      await api.register(addressRoutes)
      await api.register(marketRoutes)
      await api.register(prizeRoutes)
      await api.register(internalRoutes)
    },
    { prefix: API_PREFIX },
  )
  // Imagens enviadas pelo admin (D5), fora de /api/v1 para o front usar imageUrl = /uploads/<arquivo>
  await app.register(publicUploadRoutes)

  return app
}
