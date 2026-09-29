import { z } from 'zod'

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
})

export type Pagination = z.output<typeof paginationSchema>

export const offsetOf = (p: Pagination) => (p.page - 1) * p.pageSize

export function paginated<T>(data: T[], total: number, p: Pagination) {
  return { data, meta: { page: p.page, pageSize: p.pageSize, total } }
}

/** Escapa curingas de LIKE/ILIKE para busca literal. */
// Escapa os curingas do LIKE (e a própria barra) com "\", o caractere de escape padrão do Postgres.
export const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`)
