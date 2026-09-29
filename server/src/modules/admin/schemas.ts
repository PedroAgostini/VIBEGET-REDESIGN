import { z } from 'zod'
import { products, userLevel, userRole, userStatus } from '../../db/schema.js'
import { paginationSchema } from '../../lib/pagination.js'

export const idParams = z.object({ id: z.uuid() }).strict()

export const listUsersQuery = paginationSchema
  .extend({
    q: z.string().trim().min(1).max(120).optional(),
    role: z.enum(userRole.enumValues).optional(),
    status: z.enum(userStatus.enumValues).optional(),
    level: z.enum(userLevel.enumValues).optional(),
  })
  .strict()

export const patchUserSchema = z
  .object({
    role: z.enum(userRole.enumValues).optional(),
    // DELETED só via fluxo de exclusão (anonimização), não por PATCH.
    status: z.enum(['ACTIVE', 'SUSPENDED']).optional(),
    reason: z.string().trim().min(3).max(500).optional(),
  })
  .strict()
  .refine((d) => d.role !== undefined || d.status !== undefined, { message: 'Informe role ou status.' })

export const walletAdjustmentSchema = z
  .object({
    amountCents: z
      .number()
      .int()
      .min(-10_000_000)
      .max(10_000_000)
      .refine((v) => v !== 0, 'O valor não pode ser zero.'),
    reason: z.string().trim().min(5, 'Motivo obrigatório (mín. 5 caracteres).').max(500),
  })
  .strict()

const slug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Slug inválido (use letras minúsculas, números e hífen).').max(120)
// Imagem: caminho relativo servido pelo front (/img/...) ou URL https.
const imageUrl = z
  .string()
  .max(500)
  // "/caminho" (nunca "//host", que é URL de outro host) ou https://; o host https é checado contra IMAGE_HOSTS no service.
  .refine(
    (v) => (/^\/(?!\/)[A-Za-z0-9/_.-]+$/.test(v) && !v.includes('..')) || /^https:\/\/[^\s/?#]+\/[^\s]*$/.test(v),
    'imageUrl deve ser /caminho ou https://host-permitido/...',
  )

export const listProductsQuery = paginationSchema
  .extend({
    q: z.string().trim().min(1).max(120).optional(),
    category: z.enum(products.category.enumValues).optional(),
  })
  .strict()

export const createProductSchema = z
  .object({
    slug,
    name: z.string().trim().min(2).max(160),
    category: z.enum(products.category.enumValues),
    imageUrl: imageUrl.nullable().optional(),
    originalPriceCents: z.number().int().positive().max(1_000_000_000),
    description: z.string().trim().max(5000).nullable().optional(),
    // D10: página da Vibe
    brand: z.string().trim().min(1).max(80).nullable().optional(),
    model: z.string().trim().min(1).max(120).nullable().optional(),
    images: z.array(imageUrl).max(10, 'No máximo 10 fotos.').optional(),
    specs: z
      .array(z.object({ label: z.string().trim().min(1).max(60), value: z.string().trim().min(1).max(200) }).strict())
      .max(40, 'No máximo 40 linhas na ficha técnica.')
      .optional(),
  })
  .strict()

export const patchProductSchema = createProductSchema.partial().strict()

const MAX_VIBE_DURATION_MS = 15 * 24 * 60 * 60 * 1000

export const listVibesQuery = paginationSchema
  .extend({
    status: z.enum(['DRAFT', 'SCHEDULED', 'LIVE', 'ENDED', 'CANCELLED']).optional(),
    productId: z.uuid().optional(),
  })
  .strict()

const vibeFields = {
  productId: z.uuid(),
  slug: slug.max(140),
  status: z.enum(['DRAFT', 'SCHEDULED', 'LIVE']).default('DRAFT'),
  minGetCents: z.number().int().positive().max(100_000_00),
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date(),
  goalGets: z.number().int().positive().max(1_000_000).nullable().optional(),
  // Sem valor: usa o cashback padrão das configurações (D3).
  cashbackPercent: z.number().int().min(0).max(100).optional(),
  // D10: benefícios extras desta Vibe (os fixos da plataforma aparecem sempre na página)
  benefits: z.array(z.string().trim().min(3).max(80)).max(8, 'No máximo 8 benefícios extras.').optional(),
}

const datesOk = <T extends { startsAt: Date; endsAt: Date }>(o: z.ZodType<T>) =>
  o
    .refine((d) => d.endsAt > d.startsAt, { path: ['endsAt'], message: 'endsAt deve ser depois de startsAt.' })
    .refine((d) => d.endsAt.getTime() - d.startsAt.getTime() <= MAX_VIBE_DURATION_MS, {
      path: ['endsAt'],
      message: 'Uma Vibe dura no máximo 15 dias.',
    })

export const createVibeSchema = datesOk(z.object(vibeFields).strict())

/** D5: cadastro de leilão = produto + Vibe numa transação (tela "cadastro de leilão"). */
export const createAuctionSchema = z
  .object({
    product: createProductSchema,
    vibe: datesOk(z.object(vibeFields).omit({ productId: true }).strict()),
  })
  .strict()

export const patchVibeSchema = z
  .object({
    slug: vibeFields.slug.optional(),
    status: z.enum(['DRAFT', 'SCHEDULED', 'LIVE', 'CANCELLED']).optional(),
    minGetCents: vibeFields.minGetCents.optional(),
    startsAt: vibeFields.startsAt.optional(),
    endsAt: vibeFields.endsAt.optional(),
    goalGets: vibeFields.goalGets,
    cashbackPercent: z.number().int().min(0).max(100).optional(),
    benefits: vibeFields.benefits,
  })
  .strict()

export const listAuditQuery = paginationSchema
  .extend({
    action: z.string().max(64).optional(),
    entity: z.string().max(32).optional(),
    entityId: z.uuid().optional(),
    actorId: z.uuid().optional(),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
  })
  .strict()

export const listGetsQuery = paginationSchema
  .extend({
    vibeId: z.uuid().optional(),
    userId: z.uuid().optional(),
    status: z.enum(['PENDING_PAYMENT', 'CONFIRMED', 'FAILED', 'REFUNDED']).optional(),
  })
  .strict()

export const VIBE_MAX_DURATION_MS = MAX_VIBE_DURATION_MS
