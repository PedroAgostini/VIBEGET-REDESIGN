import { z } from 'zod'
import { birthDateSchema, cpfSchema, nameSchema, phoneSchema } from '../auth/schemas.js'

/** Campos editáveis pelo próprio usuário. Qualquer outro campo é rejeitado (.strict). */
export const updateMeSchema = z
  .object({
    name: nameSchema.optional(),
    phone: phoneSchema.nullable().optional(),
    cpf: cpfSchema.optional(),
    birthDate: birthDateSchema.optional(),
    marketingOptIn: z.boolean().optional(),
  })
  .strict()

export const deleteMeSchema = z.object({ password: z.string().min(1).max(128) }).strict()

export type UpdateMeInput = z.output<typeof updateMeSchema>
