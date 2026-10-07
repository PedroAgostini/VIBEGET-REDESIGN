import type { FastifyInstance, FastifyReply } from 'fastify'
import { authOf, metaOf } from '../../plugins/auth.js'
import { csrfGuard } from '../../plugins/security.js'
import { AppError } from '../../lib/errors.js'
import { parse } from '../../lib/validate.js'
import {
  changePasswordSchema,
  forgotSchema,
  loginSchema,
  registerSchema,
  resetSchema,
  tokenSchema,
} from './schemas.js'
import * as auth from './service.js'

export const REFRESH_COOKIE = 'vg_rt'
export const REFRESH_COOKIE_PATH = '/api/v1/auth'

/** Limites fortes por IP nas rotas sensíveis (além do global). */
const strict = (max: number, minutes = 15) => ({ rateLimit: { max, timeWindow: `${minutes} minutes` } })

export default async function authRoutes(app: FastifyInstance) {
  const { ctx } = app
  const csrf = csrfGuard(app)

  function setRefreshCookie(reply: FastifyReply, token: string, expires: Date) {
    reply.setCookie(REFRESH_COOKIE, token, {
      httpOnly: true,
      secure: ctx.env.COOKIE_SECURE,
      sameSite: 'strict',
      path: REFRESH_COOKIE_PATH,
      expires,
    })
  }
  function clearRefreshCookie(reply: FastifyReply) {
    reply.clearCookie(REFRESH_COOKIE, {
      httpOnly: true,
      secure: ctx.env.COOKIE_SECURE,
      sameSite: 'strict',
      path: REFRESH_COOKIE_PATH,
    })
  }
  function sendAuth(reply: FastifyReply, result: auth.AuthResult, status = 200) {
    setRefreshCookie(reply, result.refreshToken, result.refreshExpiresAt)
    reply.header('cache-control', 'no-store')
    return reply
      .status(status)
      .send({
        user: result.user,
        accessToken: result.accessToken,
        expiresIn: result.expiresIn,
        ...(result.couponApplied !== undefined ? { couponApplied: result.couponApplied } : {}),
      })
  }

  app.post('/auth/register', { preHandler: csrf, config: strict(10, 60) }, async (req, reply) => {
    const input = parse(registerSchema, req.body)
    return sendAuth(reply, await auth.register(ctx, input, metaOf(req)), 201)
  })

  app.post('/auth/login', { preHandler: csrf, config: strict(10) }, async (req, reply) => {
    const input = parse(loginSchema, req.body)
    return sendAuth(reply, await auth.login(ctx, input, metaOf(req)))
  })

  app.post('/auth/refresh', { preHandler: csrf, config: strict(60) }, async (req, reply) => {
    try {
      return sendAuth(reply, await auth.refresh(ctx, req.cookies[REFRESH_COOKIE], metaOf(req)))
    } catch (err) {
      // Em REFRESH_RACE o navegador já recebeu (ou vai receber) o cookie novo da outra requisição: não apagar.
      if (!(err instanceof AppError && err.code === 'REFRESH_RACE')) clearRefreshCookie(reply)
      throw err
    }
  })

  app.post('/auth/logout', { preHandler: csrf }, async (req, reply) => {
    await auth.logout(ctx, req.cookies[REFRESH_COOKIE])
    clearRefreshCookie(reply)
    return reply.status(204).send()
  })

  app.post('/auth/logout-all', { preHandler: [csrf, app.authenticate] }, async (req, reply) => {
    await auth.logoutAll(ctx, authOf(req).userId, metaOf(req))
    clearRefreshCookie(reply)
    return reply.status(204).send()
  })

  app.get('/auth/me', { preHandler: app.authenticate }, async (req) => {
    return { user: await auth.getMe(ctx, authOf(req).userId) }
  })

  app.post('/auth/verify-email', { config: strict(20) }, async (req, reply) => {
    const { token } = parse(tokenSchema, req.body)
    await auth.verifyEmail(ctx, token, metaOf(req))
    return reply.status(204).send()
  })

  app.post('/auth/resend-verification', { preHandler: app.authenticate, config: strict(5) }, async (req, reply) => {
    await auth.resendVerification(ctx, authOf(req).userId)
    return reply.status(202).send({ ok: true })
  })

  app.post('/auth/forgot-password', { config: strict(5) }, async (req, reply) => {
    const { email } = parse(forgotSchema, req.body)
    await auth.forgotPassword(ctx, email, metaOf(req))
    return reply.status(202).send({
      message: 'Se existir uma conta com esse e-mail, enviaremos um link para redefinir a senha.',
    })
  })

  app.post('/auth/reset-password', { config: strict(10) }, async (req, reply) => {
    const { token, password } = parse(resetSchema, req.body)
    await auth.resetPassword(ctx, token, password, metaOf(req))
    clearRefreshCookie(reply)
    return reply.status(204).send()
  })

  app.patch('/auth/password', { preHandler: [csrf, app.authenticate], config: strict(10) }, async (req, reply) => {
    const input = parse(changePasswordSchema, req.body)
    return sendAuth(reply, await auth.changePassword(ctx, authOf(req).userId, input, metaOf(req)))
  })
}
