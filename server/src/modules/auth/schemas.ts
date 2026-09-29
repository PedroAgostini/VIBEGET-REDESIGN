import { z } from 'zod'
import { isCommonPassword } from '../../lib/common-passwords.js'
import { normalizeCpf } from '../../lib/cpf.js'

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .pipe(z.email({ message: 'E-mail inválido.' }))

export const passwordSchema = z
  .string()
  .min(10, 'A senha precisa ter pelo menos 10 caracteres.')
  .max(128, 'A senha pode ter no máximo 128 caracteres.')
  .refine((p) => !isCommonPassword(p), 'Essa senha é muito comum. Escolha outra.')

export const nameSchema = z.string().trim().min(2, 'Informe seu nome.').max(120)

export const cpfSchema = z
  .string()
  .max(20)
  .transform((v, ctx) => {
    const n = normalizeCpf(v)
    if (!n) {
      ctx.addIssue({ code: 'custom', message: 'CPF inválido.' })
      return z.NEVER
    }
    return n
  })

export const phoneSchema = z
  .string()
  .trim()
  .max(20)
  .transform((v) => v.replace(/[^\d+]/g, ''))
  .refine((v) => /^\+?\d{10,14}$/.test(v), 'Telefone inválido.')

export const birthDateSchema = z.iso
  .date({ message: 'Data de nascimento inválida (use AAAA-MM-DD).' })
  .refine((d) => d >= '1900-01-01' && d <= new Date().toISOString().slice(0, 10), 'Data de nascimento inválida.')

export const registerSchema = z
  .object({
    name: nameSchema,
    email: emailSchema,
    password: passwordSchema,
    cpf: cpfSchema.optional(),
    phone: phoneSchema.optional(),
    birthDate: birthDateSchema.optional(),
    acceptTerms: z.literal(true, { message: 'É preciso aceitar os termos de uso.' }),
    marketingOptIn: z.boolean().optional(),
    referralCode: z.string().trim().toUpperCase().min(4).max(16).optional(),
    // D4: cupom opcional. Formato NÃO é validado aqui: cupom inválido nunca faz o cadastro falhar.
    couponCode: z.string().max(64).optional(),
  })
  .strict()
  .refine((d) => d.password.toLowerCase() !== d.email, {
    path: ['password'],
    message: 'A senha não pode ser igual ao e-mail.',
  })

export const loginSchema = z
  .object({
    email: emailSchema,
    password: z.string().min(1).max(128),
  })
  .strict()

export const tokenSchema = z.object({ token: z.string().min(20).max(200) }).strict()

export const forgotSchema = z.object({ email: emailSchema }).strict()

export const resetSchema = z.object({ token: z.string().min(20).max(200), password: passwordSchema }).strict()

export const changePasswordSchema = z
  .object({ currentPassword: z.string().min(1).max(128), newPassword: passwordSchema })
  .strict()
  .refine((d) => d.currentPassword !== d.newPassword, {
    path: ['newPassword'],
    message: 'A nova senha precisa ser diferente da atual.',
  })

export type RegisterInput = z.output<typeof registerSchema>
