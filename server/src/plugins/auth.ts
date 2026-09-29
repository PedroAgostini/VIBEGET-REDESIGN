import jwt from '@fastify/jwt'
import { and, eq, gt, isNull } from 'drizzle-orm'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import fp from 'fastify-plugin'
import type { AccessTokenPayload, RequestMeta } from '../context.js'
import { sessions, users, type Role } from '../db/schema.js'
import { forbidden, unauthorized } from '../lib/errors.js'

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: AccessTokenPayload
    user: AccessTokenPayload
  }
}

type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: PreHandler
    requireRole: (...roles: Role[]) => PreHandler
  }
}

export default fp(async function authPlugin(app: FastifyInstance) {
  const { env, db } = app.ctx
  await app.register(jwt, {
    secret: env.JWT_SECRET,
    sign: { algorithm: 'HS256', expiresIn: env.ACCESS_TOKEN_TTL_SECONDS, iss: 'vibeget', aud: 'vibeget-api' },
    verify: { algorithms: ['HS256'], allowedIss: 'vibeget', allowedAud: 'vibeget-api' },
  })

  app.ctx.signAccessToken = (payload) => app.jwt.sign(payload)
  app.decorateRequest('auth', null)

  /**
   * Valida o JWT e confirma no banco que o usuário continua ACTIVE e que a sessão
   * (family_id) não foi revogada. A role efetiva vem do banco, não do token.
   */
  app.decorate('authenticate', async function (req: FastifyRequest) {
    let payload: AccessTokenPayload
    try {
      payload = await req.jwtVerify<AccessTokenPayload>()
    } catch {
      throw unauthorized('Sessão inválida ou expirada.', 'INVALID_TOKEN')
    }
    if (typeof payload.sub !== 'string' || typeof payload.sid !== 'string') {
      throw unauthorized('Sessão inválida ou expirada.', 'INVALID_TOKEN')
    }
    const [row] = await db
      .select({ id: users.id, role: users.role, status: users.status })
      .from(users)
      .where(eq(users.id, payload.sub))
      .limit(1)
    if (!row || row.status !== 'ACTIVE') throw unauthorized('Sessão inválida ou expirada.', 'INVALID_TOKEN')

    const [session] = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(
        and(
          eq(sessions.familyId, payload.sid),
          eq(sessions.userId, row.id),
          isNull(sessions.revokedAt),
          gt(sessions.expiresAt, new Date()),
        ),
      )
      .limit(1)
    if (!session) throw unauthorized('Sessão inválida ou expirada.', 'INVALID_TOKEN')

    req.auth = { userId: row.id, role: row.role, sessionFamilyId: payload.sid }
  })

  app.decorate('requireRole', function (...roles: Role[]): PreHandler {
    return async function (req: FastifyRequest) {
      if (!req.auth) throw unauthorized()
      if (!roles.includes(req.auth.role)) throw forbidden()
    }
  })
})

/** Garante que a rota passou por authenticate. */
export function authOf(req: FastifyRequest) {
  if (!req.auth) throw unauthorized()
  return req.auth
}

export function metaOf(req: FastifyRequest): RequestMeta {
  const ua = req.headers['user-agent']
  return { ip: req.ip, userAgent: typeof ua === 'string' ? ua.slice(0, 512) : null, receivedAt: req.receivedAt }
}
