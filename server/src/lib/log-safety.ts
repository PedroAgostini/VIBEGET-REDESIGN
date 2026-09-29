/**
 * Erros de banco (DrizzleQueryError / erro do driver) carregam a query e os VALORES dos parâmetros
 * (e-mail, CPF, hashes...). Nada disso pode ir para o log.
 */

/** Remove parâmetros e literais de uma mensagem/stack de erro. */
export function sanitizeErrorText(text: string): string {
  return text
    .replace(/params:[^\n]*/gi, 'params: [REDACTED]')
    .replace(/"[^"\n]*"/g, '"?"')
    .replace(/'[^'\n]*'/g, "'?'")
}

type ErrLike = { name?: unknown; message?: unknown; code?: unknown; constraint?: unknown; cause?: unknown; stack?: unknown }

/** Versão segura de um erro para log: tipo, code/constraint do Postgres e mensagem sanitizada. */
export function safeErrorForLog(err: unknown) {
  const e = (err ?? {}) as ErrLike
  const cause = (e.cause ?? {}) as ErrLike
  const isDbError = 'params' in (e as object) || 'query' in (e as object) || typeof cause.code === 'string'
  const message = typeof e.message === 'string' ? e.message : String(err)
  return {
    type: typeof e.name === 'string' ? e.name : 'Error',
    code: typeof e.code === 'string' ? e.code : typeof cause.code === 'string' ? cause.code : undefined,
    constraint:
      typeof e.constraint === 'string' ? e.constraint : typeof cause.constraint === 'string' ? cause.constraint : undefined,
    // Para erro de banco a mensagem do Drizzle é a própria query; usa a do driver, sanitizada.
    message: sanitizeErrorText(isDbError && typeof cause.message === 'string' ? cause.message : message),
    stack: typeof e.stack === 'string' && !isDbError ? sanitizeErrorText(e.stack) : undefined,
  }
}

/** Censor do pino: parâmetros/queries somem; mensagens e stacks são sanitizadas. */
export function logCensor(value: unknown, path: string[]): unknown {
  const key = path[path.length - 1]
  if ((key === 'message' || key === 'stack') && typeof value === 'string') return sanitizeErrorText(value)
  return '[REDACTED]'
}
