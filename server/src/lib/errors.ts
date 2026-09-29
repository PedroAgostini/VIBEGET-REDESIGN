export interface ErrorDetail {
  path?: string
  message: string
}

/** Erro de domínio com código estável e mensagem pt-BR segura para o cliente. */
export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: ErrorDetail[],
  ) {
    super(message)
    this.name = 'AppError'
  }
}

export const badRequest = (message: string, code = 'BAD_REQUEST', details?: ErrorDetail[]) =>
  new AppError(400, code, message, details)
export const unauthorized = (message = 'Não autenticado.', code = 'UNAUTHORIZED') =>
  new AppError(401, code, message)
export const forbidden = (message = 'Você não tem permissão para esta ação.', code = 'FORBIDDEN') =>
  new AppError(403, code, message)
export const notFound = (message = 'Recurso não encontrado.', code = 'NOT_FOUND') =>
  new AppError(404, code, message)
export const conflict = (message: string, code = 'CONFLICT') => new AppError(409, code, message)
export const unprocessable = (message: string, code = 'UNPROCESSABLE') => new AppError(422, code, message)

/** Detecta violação de unicidade do Postgres, inclusive embrulhada pelo Drizzle (DrizzleQueryError.cause). */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  let cur: unknown = err
  for (let i = 0; i < 5 && cur; i++) {
    const e = cur as { code?: string; constraint?: string; message?: string; cause?: unknown }
    if (e.code === '23505') {
      if (!constraint) return true
      return e.constraint === constraint || (e.message ?? '').includes(constraint)
    }
    cur = e.cause
  }
  return false
}
