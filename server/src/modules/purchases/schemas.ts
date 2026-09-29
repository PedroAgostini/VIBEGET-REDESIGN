import { z } from 'zod'

const MAX_CENTS = 10_000_000 // R$ 100.000,00

/** D11: exatamente um entre packageId (pacote) e customGetcoinsCents (avulsa, GetCoins inteiros). */
export const createPurchaseSchema = z
  .object({
    packageId: z.uuid().optional(),
    customGetcoinsCents: z
      .number()
      .int()
      .positive()
      .max(100_000_000)
      .refine((v) => v % 100 === 0, 'Use GetCoins inteiros (múltiplos de 100).')
      .optional(),
    method: z.enum(['PIX', 'CARD', 'BALANCE']),
  })
  .strict()
  .refine((d) => (d.packageId === undefined) !== (d.customGetcoinsCents === undefined), {
    message: 'Informe exatamente um: packageId ou customGetcoinsCents.',
  })

export const createPackageSchema = z
  .object({
    name: z.string().trim().min(2).max(80),
    getcoinsCents: z.number().int().positive().max(MAX_CENTS),
    bonusCents: z.number().int().min(0).max(MAX_CENTS).default(0),
    priceCents: z.number().int().positive().max(MAX_CENTS),
    active: z.boolean().default(true),
    sortOrder: z.number().int().min(0).max(10_000).default(0),
  })
  .strict()

export const patchPackageSchema = z
  .object({
    name: z.string().trim().min(2).max(80).optional(),
    getcoinsCents: z.number().int().positive().max(MAX_CENTS).optional(),
    bonusCents: z.number().int().min(0).max(MAX_CENTS).optional(),
    priceCents: z.number().int().positive().max(MAX_CENTS).optional(),
    active: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(10_000).optional(),
  })
  .strict()
  .refine((d) => Object.keys(d).length > 0, { message: 'Nada para atualizar.' })
