import { and, count, desc, eq, inArray, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import type { AppContext, RequestMeta } from '../../context.js'
import type { DbOrTx } from '../../db/client.js'
import { gets, prizeDeliveries, products, users, vibes, type PrizeDelivery } from '../../db/schema.js'
import { audit } from '../../lib/audit.js'
import { AppError, notFound } from '../../lib/errors.js'
import { offsetOf, paginated, type Pagination } from '../../lib/pagination.js'
import { addressSchema } from '../address/service.js'

export const PRIZE_STATUSES = prizeDeliveries.status.enumValues
export type PrizeStatus = (typeof PRIZE_STATUSES)[number]
/** Enquanto não foi entregue, o prêmio segura a exclusão da conta (LGPD). */
export const OPEN_PRIZE_STATUSES: PrizeStatus[] = ['AWAITING_ADDRESS', 'PREPARING', 'SHIPPED']

export const confirmAddressSchema = addressSchema
  .extend({
    recipientName: z.string().trim().min(3, 'Informe o nome de quem vai receber.').max(120),
    phone: z
      .string()
      .transform((v) => v.replace(/\D/g, ''))
      .refine((v) => /^\d{10,11}$/.test(v), 'Informe um celular com DDD.'),
  })
  .strict()

export const shipSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('SHIPPED'),
      carrier: z.string().trim().min(2, 'Informe a transportadora.').max(60),
      trackingCode: z.string().trim().min(4, 'Informe o código de rastreio.').max(60),
    })
    .strict(),
  z.object({ status: z.literal('DELIVERED') }).strict(),
])

const prizeRow = {
  d: prizeDeliveries,
  vibe: { id: vibes.id, slug: vibes.slug, settledAt: vibes.settledAt },
  product: { name: products.name, imageUrl: products.imageUrl, category: products.category, originalPriceCents: products.originalPriceCents },
  winningGetCents: gets.totalCents,
}

function toPrize(r: { d: PrizeDelivery; vibe: { id: string; slug: string; settledAt: Date | null }; product: object; winningGetCents: number }) {
  const d = r.d
  return {
    id: d.id,
    status: d.status,
    vibe: r.vibe,
    product: r.product,
    winningGetCents: r.winningGetCents,
    recipientName: d.recipientName,
    phone: d.phone,
    address: d.cep
      ? { cep: d.cep, street: d.street, number: d.number, complement: d.complement, district: d.district, city: d.city, state: d.state }
      : null,
    addressConfirmedAt: d.addressConfirmedAt,
    carrier: d.carrier,
    trackingCode: d.trackingCode,
    shippedAt: d.shippedAt,
    deliveredAt: d.deliveredAt,
    createdAt: d.createdAt,
  }
}

function baseQuery(db: DbOrTx) {
  return db
    .select(prizeRow)
    .from(prizeDeliveries)
    .innerJoin(vibes, eq(vibes.id, prizeDeliveries.vibeId))
    .innerJoin(products, eq(products.id, vibes.productId))
    .innerJoin(gets, eq(gets.id, prizeDeliveries.getId))
}

export async function listMyPrizes(db: DbOrTx, userId: string) {
  const rows = await baseQuery(db).where(eq(prizeDeliveries.userId, userId)).orderBy(desc(prizeDeliveries.createdAt))
  return rows.map(toPrize)
}

export async function countOpenPrizes(db: DbOrTx, userId: string) {
  const [{ n } = { n: 0 }] = await db
    .select({ n: count() })
    .from(prizeDeliveries)
    .where(and(eq(prizeDeliveries.userId, userId), inArray(prizeDeliveries.status, OPEN_PRIZE_STATUSES)))
  return n
}

/** Vencedor confirma (ou troca) o endereço. Depois do envio o endereço não muda mais por aqui. */
export async function confirmAddress(
  ctx: AppContext,
  userId: string,
  prizeId: string,
  input: z.output<typeof confirmAddressSchema>,
  meta: RequestMeta,
) {
  await ctx.db.transaction(async (tx) => {
    const [d] = await tx.select().from(prizeDeliveries).where(eq(prizeDeliveries.id, prizeId)).for('update')
    if (!d || d.userId !== userId) throw notFound('Prêmio não encontrado.')
    if (d.status !== 'AWAITING_ADDRESS' && d.status !== 'PREPARING') {
      throw new AppError(409, 'PRIZE_ALREADY_SHIPPED', 'O prêmio já foi enviado. Para mudar o endereço, fale com o suporte.')
    }
    await tx
      .update(prizeDeliveries)
      .set({ ...input, complement: input.complement || null, status: 'PREPARING', addressConfirmedAt: new Date() })
      .where(eq(prizeDeliveries.id, prizeId))
    await audit(tx, {
      actorId: userId,
      action: d.status === 'AWAITING_ADDRESS' ? 'PRIZE_ADDRESS_CONFIRMED' : 'PRIZE_ADDRESS_CHANGED',
      entity: 'prize',
      entityId: prizeId,
      ip: meta.ip,
    })
  })
  const [row] = await baseQuery(ctx.db).where(eq(prizeDeliveries.id, prizeId))
  return toPrize(row!)
}

// ---------- admin ----------

export async function listPrizesAdmin(db: DbOrTx, q: Pagination & { status?: PrizeStatus | undefined }) {
  const where: SQL | undefined = q.status ? eq(prizeDeliveries.status, q.status) : undefined
  const [rows, [{ total } = { total: 0 }]] = await Promise.all([
    baseQuery(db).where(where).orderBy(desc(prizeDeliveries.createdAt), desc(prizeDeliveries.id)).limit(q.pageSize).offset(offsetOf(q)),
    db.select({ total: count() }).from(prizeDeliveries).where(where),
  ])
  const ids = [...new Set(rows.map((r) => r.d.userId))]
  const people = ids.length
    ? await db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(inArray(users.id, ids))
    : []
  const byId = new Map(people.map((p) => [p.id, p]))
  return paginated(
    rows.map((r) => ({ ...toPrize(r), user: byId.get(r.d.userId) ?? null })),
    total,
    q,
  )
}

/** ADMIN: PREPARING -> SHIPPED (transportadora + rastreio; pode corrigir o rastreio enquanto SHIPPED) -> DELIVERED. */
export async function updatePrizeAdmin(
  ctx: AppContext,
  actorId: string,
  prizeId: string,
  input: z.output<typeof shipSchema>,
  meta: RequestMeta,
) {
  await ctx.db.transaction(async (tx) => {
    const [d] = await tx.select().from(prizeDeliveries).where(eq(prizeDeliveries.id, prizeId)).for('update')
    if (!d) throw notFound('Prêmio não encontrado.')
    const invalid = () => new AppError(409, 'PRIZE_INVALID_TRANSITION', `Não é possível passar de ${d.status} para ${input.status}.`)
    if (input.status === 'SHIPPED') {
      if (d.status !== 'PREPARING' && d.status !== 'SHIPPED') throw invalid()
      await tx
        .update(prizeDeliveries)
        .set({ status: 'SHIPPED', carrier: input.carrier, trackingCode: input.trackingCode, shippedAt: d.shippedAt ?? new Date() })
        .where(eq(prizeDeliveries.id, prizeId))
    } else {
      if (d.status !== 'SHIPPED') throw invalid()
      await tx.update(prizeDeliveries).set({ status: 'DELIVERED', deliveredAt: new Date() }).where(eq(prizeDeliveries.id, prizeId))
    }
    await audit(tx, {
      actorId,
      action: input.status === 'SHIPPED' ? (d.status === 'SHIPPED' ? 'PRIZE_TRACKING_UPDATED' : 'PRIZE_SHIPPED') : 'PRIZE_DELIVERED',
      entity: 'prize',
      entityId: prizeId,
      metadata: { from: d.status, to: input.status, ...(input.status === 'SHIPPED' ? { carrier: input.carrier } : {}) },
      ip: meta.ip,
    })
  })
  const [row] = await baseQuery(ctx.db).where(eq(prizeDeliveries.id, prizeId))
  return toPrize(row!)
}
