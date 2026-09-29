import type { z } from 'zod'
import { AppError } from './errors.js'

/** Valida com Zod e converte falhas em 400 VALIDATION_ERROR com detalhes por campo. */
export function parse<S extends z.ZodType>(schema: S, data: unknown): z.output<S> {
  const r = schema.safeParse(data)
  if (!r.success) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      'Dados inválidos.',
      r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    )
  }
  return r.data
}
