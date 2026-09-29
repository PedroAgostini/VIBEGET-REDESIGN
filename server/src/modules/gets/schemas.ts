import { z } from 'zod'

const MAX_GET_CENTS = 100_000_00 // R$ 100.000,00 por Get (limite de sanidade)

export const createGetSchema = z
  .object({
    cashCents: z.number().int().positive().max(MAX_GET_CENTS),
    getcoinCents: z.number().int().min(0).max(MAX_GET_CENTS).default(0),
    // D6: BALANCE = paga com o saldo em R$ e o Get já nasce CONFIRMED
    method: z.enum(['PIX', 'CARD', 'BALANCE']),
  })
  .strict()
  .refine((d) => d.getcoinCents <= d.cashCents, {
    path: ['getcoinCents'],
    message: 'O GetCoin usado não pode passar do valor pago em dinheiro.',
  })

export const idempotencyKeySchema = z
  .string({ message: 'Header Idempotency-Key é obrigatório.' })
  .regex(/^[A-Za-z0-9_\-:.]{8,128}$/, 'Idempotency-Key inválida (8 a 128 caracteres: letras, números, _ - : .).')

export const vibeIdParams = z.object({ id: z.uuid() }).strict()

export type CreateGetInput = z.output<typeof createGetSchema>
