import { z } from 'zod'
import { paginationSchema } from '../../lib/pagination.js'

/** Código normalizado para MAIÚSCULAS (cupom não diferencia caixa). */
export const couponCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9_-]{3,40}$/, 'Código: 3 a 40 caracteres (letras, números, _ e -).')

export const redeemSchema = z.object({ code: z.string().max(64) }).strict()

const MAX_COUPON_CENTS = 100_000 // R$ 1.000,00 em GetCoin por resgate

export const createCouponSchema = z
  .object({
    code: couponCodeSchema,
    amountCents: z.number().int().positive().max(MAX_COUPON_CENTS),
    maxRedemptions: z.number().int().positive().max(10_000_000).nullable().optional(),
    perUserLimit: z.number().int().min(1).max(100).default(1),
    startsAt: z.coerce.date().optional(),
    endsAt: z.coerce.date().nullable().optional(),
    active: z.boolean().default(true),
    newAccountsOnly: z.boolean().default(false),
    description: z.string().trim().max(200).nullable().optional(),
  })
  .strict()
  .refine((d) => !d.endsAt || d.endsAt > (d.startsAt ?? new Date()), {
    path: ['endsAt'],
    message: 'endsAt deve ser depois de startsAt.',
  })

export const patchCouponSchema = z
  .object({
    amountCents: z.number().int().positive().max(MAX_COUPON_CENTS).optional(),
    maxRedemptions: z.number().int().positive().max(10_000_000).nullable().optional(),
    perUserLimit: z.number().int().min(1).max(100).optional(),
    startsAt: z.coerce.date().optional(),
    endsAt: z.coerce.date().nullable().optional(),
    active: z.boolean().optional(),
    newAccountsOnly: z.boolean().optional(),
    description: z.string().trim().max(200).nullable().optional(),
  })
  .strict()
  .refine((d) => Object.keys(d).length > 0, { message: 'Nada para atualizar.' })

export const listCouponsQuery = paginationSchema
  .extend({
    q: z.string().trim().min(1).max(40).optional(),
    active: z.enum(['true', 'false']).optional(),
  })
  .strict()

export const listRedemptionsQuery = paginationSchema.strict()

export type CreateCouponInput = z.output<typeof createCouponSchema>
export type PatchCouponInput = z.output<typeof patchCouponSchema>
