import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import rateLimit from '@fastify/rate-limit'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import fp from 'fastify-plugin'
import { AppError } from '../lib/errors.js'

export interface SecurityOptions {
  rateLimit: boolean
}

export default fp<SecurityOptions>(async function securityPlugin(app: FastifyInstance, opts) {
  const { env } = app.ctx
  const allow = new Set(env.CORS_ORIGINS)

  await app.register(helmet, {
    // API JSON pura: CSP restritiva, sem recursos embutidos.
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
    crossOriginResourcePolicy: { policy: 'same-site' },
    hsts: env.isProduction ? { maxAge: 31_536_000, includeSubDomains: true } : false,
  })

  await app.register(cors, {
    origin: (origin, cb) => {
      // Sem Origin = chamada não-navegador (curl, server-to-server); CORS não se aplica.
      if (!origin) return cb(null, true)
      cb(null, allow.has(origin))
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Idempotency-Key'],
    maxAge: 600,
  })

  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: '1 minute',
    enableDraftSpec: true,
    allowList: () => !opts.rateLimit,
    errorResponseBuilder: () =>
      new AppError(429, 'RATE_LIMITED', 'Muitas requisições. Tente novamente em instantes.'),
  })
})

/**
 * CSRF para rotas que leem/escrevem o cookie de refresh.
 * Exige `X-Requested-With: fetch` (força preflight CORS em chamadas cross-site) e,
 * quando o navegador envia Origin, que ela esteja na allowlist. Em produção Origin é obrigatória.
 */
export function csrfGuard(app: FastifyInstance) {
  const allow = new Set(app.ctx.env.CORS_ORIGINS)
  const requireOrigin = app.ctx.env.isProduction
  const reject = () => new AppError(403, 'CSRF_REJECTED', 'Requisição bloqueada (CSRF).')
  return async function (req: FastifyRequest, _reply: FastifyReply) {
    if (req.headers['x-requested-with'] !== 'fetch') throw reject()
    const origin = req.headers.origin
    if (origin === undefined) {
      if (requireOrigin) throw reject()
      return
    }
    if (!allow.has(origin)) throw reject()
  }
}
