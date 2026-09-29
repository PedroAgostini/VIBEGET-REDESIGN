import type { FastifyError, FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'
import { ZodError } from 'zod'
import { AppError, isUniqueViolation } from '../lib/errors.js'
import { safeErrorForLog } from '../lib/log-safety.js'

type Body = { error: { code: string; message: string; details?: unknown[] } }

const body = (code: string, message: string, details?: unknown[]): Body => ({
  error: details ? { code, message, details } : { code, message },
})

/** Formato único de erro. Nunca devolve stack, SQL ou mensagem interna ao cliente. */
export default fp(async function errorsPlugin(app: FastifyInstance) {
  app.setNotFoundHandler((_req, reply) => {
    reply.status(404).send(body('NOT_FOUND', 'Rota não encontrada.'))
  })

  app.setErrorHandler((err: FastifyError | Error, req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.statusCode).send(body(err.code, err.message, err.details))
    }
    if (err instanceof ZodError) {
      return reply.status(400).send(
        body(
          'VALIDATION_ERROR',
          'Dados inválidos.',
          err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        ),
      )
    }
    if (isUniqueViolation(err)) {
      return reply.status(409).send(body('CONFLICT', 'Registro já existe.'))
    }

    const fe = err as FastifyError
    const status = fe.statusCode ?? 500
    if (fe.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      return reply.status(413).send(body('PAYLOAD_TOO_LARGE', 'Corpo da requisição muito grande.'))
    }
    if (fe.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') {
      return reply.status(415).send(body('UNSUPPORTED_MEDIA_TYPE', 'Content-Type não suportado.'))
    }
    if (status === 429) {
      return reply.status(429).send(body('RATE_LIMITED', 'Muitas requisições. Tente novamente em instantes.'))
    }
    if (status >= 400 && status < 500) {
      const code = err instanceof SyntaxError || fe.code === 'FST_ERR_CTP_INVALID_JSON_BODY' ? 'INVALID_JSON' : 'BAD_REQUEST'
      return reply.status(status).send(body(code, 'Requisição inválida.'))
    }

    req.log.error({ error: safeErrorForLog(err) }, 'erro não tratado')
    return reply.status(500).send(body('INTERNAL_ERROR', 'Erro interno. Tente novamente mais tarde.'))
  })
})
