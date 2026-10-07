import { randomUUID } from 'node:crypto'
import { and, asc, count, desc, eq, inArray, sql } from 'drizzle-orm'
import type { AppContext } from '../../context.js'
import type { DbOrTx } from '../../db/client.js'
import { gets, payments, products, users, vibes } from '../../db/schema.js'
import { ageOn } from '../../lib/cpf.js'
import { AppError, conflict, forbidden, isUniqueViolation, notFound } from '../../lib/errors.js'
import { offsetOf, paginated, type Pagination } from '../../lib/pagination.js'
import { mockProvider, paymentPublicColumns } from '../payments/service.js'
import { applyWalletMovement } from '../wallet/service.js'
import { applyCashMovement } from '../cash/service.js'
import { audit } from '../../lib/audit.js'
import { randomToken } from '../../lib/crypto.js'
import type { CreateGetInput } from './schemas.js'
import { vibeDeadlines } from '../vibes/deadlines.js'

export const getPublicColumns = {
  id: gets.id,
  vibeId: gets.vibeId,
  cashCents: gets.cashCents,
  getcoinCents: gets.getcoinCents,
  totalCents: gets.totalCents,
  status: gets.status,
  createdAt: gets.createdAt,
}

async function loadGetWithPayment(db: DbOrTx, getId: string) {
  const [g] = await db.select(getPublicColumns).from(gets).where(eq(gets.id, getId))
  const [p] = await db.select(paymentPublicColumns).from(payments).where(eq(payments.getId, getId))
  return { get: g!, payment: p ?? null }
}

/** D10: um Get do próprio usuário com o pagamento (a página da Vibe acompanha o Pix por aqui). Outro usuário = 404. */
export async function getMyGet(db: DbOrTx, userId: string, getId: string) {
  const [g] = await db.select({ userId: gets.userId }).from(gets).where(eq(gets.id, getId))
  if (!g || g.userId !== userId) throw notFound('Get não encontrado.')
  return loadGetWithPayment(db, getId)
}

/** Pré-requisitos do usuário para dar Get (regra 6.1). */
async function assertEligible(db: DbOrTx, userId: string) {
  const [u] = await db.select().from(users).where(eq(users.id, userId))
  if (!u || u.status !== 'ACTIVE') throw forbidden('Conta inativa.', 'ACCOUNT_INACTIVE')
  if (!u.emailVerifiedAt) throw forbidden('Confirme seu e-mail antes de dar um Get.', 'EMAIL_NOT_VERIFIED')
  if (!u.cpf) throw new AppError(422, 'CPF_REQUIRED', 'Informe seu CPF no perfil antes de dar um Get.')
  if (!u.birthDate) {
    throw new AppError(422, 'BIRTHDATE_REQUIRED', 'Informe sua data de nascimento no perfil antes de dar um Get.')
  }
  if (ageOn(u.birthDate) < 18) throw forbidden('É preciso ter 18 anos ou mais para dar um Get.', 'UNDERAGE')
}

/**
 * Cria um Get pendente de pagamento (regras 6.1–6.4).
 * Idempotente por (usuário, Idempotency-Key): repetir devolve o mesmo Get.
 * Locks: vibe FOR SHARE (bloqueia settlement concorrente) -> wallet FOR UPDATE.
 */
export async function createGet(
  ctx: AppContext,
  userId: string,
  vibeId: string,
  input: CreateGetInput,
  idempotencyKey: string,
) {
  const { db, env } = ctx

  const replay = async () => {
    const [existing] = await db
      .select()
      .from(gets)
      .where(and(eq(gets.userId, userId), eq(gets.idempotencyKey, idempotencyKey)))
    if (!existing) return null
    const [pay] = await db.select({ method: payments.method }).from(payments).where(eq(payments.getId, existing.id))
    const same =
      existing.vibeId === vibeId &&
      existing.cashCents === input.cashCents &&
      existing.getcoinCents === input.getcoinCents &&
      pay?.method === input.method
    if (!same) {
      throw conflict('Idempotency-Key já usada com outros dados.', 'IDEMPOTENCY_KEY_REUSED')
    }
    return { ...(await loadGetWithPayment(db, existing.id)), replayed: true }
  }

  const prior = await replay()
  if (prior) return prior

  await assertEligible(db, userId)
  const cfg = await ctx.settings.get()

  try {
    const getId = await db.transaction(async (tx) => {
      const [vibe] = await tx.select().from(vibes).where(eq(vibes.id, vibeId)).for('share')
      if (!vibe) throw notFound('Vibe não encontrada.')
      const now = new Date()
      if (vibe.status !== 'LIVE' || vibe.settledAt || now < vibe.startsAt || now >= vibe.endsAt) {
        throw new AppError(409, 'VIBE_NOT_LIVE', 'Esta Vibe não está aceitando Gets agora.')
      }
      // D1: nenhum Get novo no último get_cutoff_seconds antes do fim.
      const { cutoffAt, paymentDeadline } = vibeDeadlines(vibe.endsAt, cfg)
      if (now >= cutoffAt) {
        throw new AppError(409, 'VIBE_CLOSING', 'Esta Vibe está no minuto final e não aceita mais Gets.')
      }
      const totalCents = input.cashCents + input.getcoinCents
      if (totalCents < vibe.minGetCents) {
        throw new AppError(422, 'GET_BELOW_MINIMUM', 'O valor total do Get está abaixo do mínimo desta Vibe.')
      }

      const id = randomUUID()
      await tx.insert(gets).values({
        id,
        vibeId,
        userId,
        cashCents: input.cashCents,
        getcoinCents: input.getcoinCents,
        totalCents,
        status: input.method === 'BALANCE' ? 'CONFIRMED' : 'PENDING_PAYMENT',
        idempotencyKey,
      })
      if (input.getcoinCents > 0) {
        await applyWalletMovement(tx, {
          userId,
          amountCents: -input.getcoinCents,
          type: 'SPEND_ON_GET',
          referenceType: 'get',
          referenceId: id,
          reason: 'GetCoin usado para turbinar Get',
        })
      }
      if (input.method === 'BALANCE') {
        // D6: pago com saldo em R$, confirmado na hora e sem provedor. Lock: carteira GetCoin -> carteira R$.
        await applyCashMovement(tx, {
          userId,
          amountCents: -input.cashCents,
          type: 'GET_PAYMENT',
          referenceType: 'get',
          referenceId: id,
          reason: 'Pagamento de Get com saldo',
        })
        await tx.insert(payments).values({
          getId: id,
          provider: 'INTERNAL',
          method: 'BALANCE',
          status: 'PAID',
          amountCents: input.cashCents,
          externalId: `bal_${randomToken(16)}`,
          pixCopyPaste: null,
          expiresAt: now,
          paidAt: now,
        })
        await audit(tx, { actorId: userId, action: 'PAYMENT_PAID', entity: 'get', entityId: id, metadata: { method: 'BALANCE' } })
        return id
      }
      const charge = mockProvider.createCharge({ amountCents: input.cashCents, method: input.method })
      await tx.insert(payments).values({
        getId: id,
        provider: 'MOCK',
        method: input.method,
        status: 'PENDING',
        amountCents: input.cashCents,
        externalId: charge.externalId,
        pixCopyPaste: charge.pixCopyPaste,
        // D1: o pagamento vence no TTL normal ou no prazo final da Vibe, o que vier primeiro.
        expiresAt: new Date(Math.min(now.getTime() + env.PAYMENT_TTL_MINUTES * 60_000, paymentDeadline.getTime())),
      })
      return id
    })
    return { ...(await loadGetWithPayment(db, getId)), replayed: false }
  } catch (err) {
    // Corrida com a mesma chave: a outra requisição venceu; devolve o Get dela.
    if (isUniqueViolation(err, 'gets_user_idempotency_uq')) {
      const again = await replay()
      if (again) return again
    }
    throw err
  }
}

export async function listMyGets(db: DbOrTx, userId: string, p: Pagination) {
  const where = eq(gets.userId, userId)
  const [rows, [{ total } = { total: 0 }]] = await Promise.all([
    db
      .select({
        ...getPublicColumns,
        vibe: { slug: vibes.slug, status: vibes.status, endsAt: vibes.endsAt, winnerGetId: vibes.winnerGetId },
        product: { name: products.name, imageUrl: products.imageUrl },
        payment: { id: payments.id, status: payments.status, method: payments.method, expiresAt: payments.expiresAt },
      })
      .from(gets)
      .innerJoin(vibes, eq(vibes.id, gets.vibeId))
      .innerJoin(products, eq(products.id, vibes.productId))
      .leftJoin(payments, eq(payments.getId, gets.id))
      .where(where)
      .orderBy(desc(gets.createdAt), desc(gets.id))
      .limit(p.pageSize)
      .offset(offsetOf(p)),
    db.select({ total: count() }).from(gets).where(where),
  ])
  const tops = await topConfirmedGets(db, [...new Set(rows.filter((r) => r.vibe.status === 'LIVE').map((r) => r.vibeId))])
  return paginated(
    rows.map(({ vibe, ...r }) => ({
      ...r,
      vibe: { slug: vibe.slug, status: vibe.status, endsAt: vibe.endsAt },
      vibeStatus: vibe.status,
      isChampion: vibe.winnerGetId === r.id,
      // D9: este Get é hoje o maior Get confirmado de uma Vibe LIVE
      isLeading: vibe.status === 'LIVE' && tops.get(r.vibeId)?.getId === r.id,
    })),
    total,
    p,
  )
}

// ---------- D9: Meus Gets ----------

/** Maior Get CONFIRMED por Vibe (desempate: mais antigo, depois id) — mesma regra do settlement. */
async function topConfirmedGets(db: DbOrTx, vibeIds: string[]) {
  const map = new Map<string, { getId: string; userId: string }>()
  if (vibeIds.length === 0) return map
  const rows = await db
    .selectDistinctOn([gets.vibeId], { vibeId: gets.vibeId, getId: gets.id, userId: gets.userId })
    .from(gets)
    .where(and(inArray(gets.vibeId, vibeIds), eq(gets.status, 'CONFIRMED')))
    .orderBy(gets.vibeId, desc(gets.totalCents), asc(gets.createdAt), asc(gets.id))
  for (const r of rows) map.set(r.vibeId, { getId: r.getId, userId: r.userId })
  return map
}

/** Vibes LIVE em que o maior Get confirmado atual é do usuário. Nunca expõe dados de outros usuários. */
export async function leadingVibes(db: DbOrTx, userId: string) {
  const mine = await db
    .selectDistinct({ vibeId: gets.vibeId })
    .from(gets)
    .innerJoin(vibes, eq(vibes.id, gets.vibeId))
    .where(and(eq(gets.userId, userId), eq(gets.status, 'CONFIRMED'), eq(vibes.status, 'LIVE')))
  const tops = await topConfirmedGets(
    db,
    mine.map((m) => m.vibeId),
  )
  const leadingGetIds = [...tops.values()].filter((t) => t.userId === userId).map((t) => t.getId)
  if (leadingGetIds.length === 0) return []
  const rows = await db
    .select({
      get: { id: gets.id, totalCents: gets.totalCents, cashCents: gets.cashCents, getcoinCents: gets.getcoinCents, createdAt: gets.createdAt },
      vibe: { id: vibes.id, slug: vibes.slug, endsAt: vibes.endsAt, minGetCents: vibes.minGetCents },
      product: { name: products.name, slug: products.slug, imageUrl: products.imageUrl },
    })
    .from(gets)
    .innerJoin(vibes, eq(vibes.id, gets.vibeId))
    .innerJoin(products, eq(products.id, vibes.productId))
    .where(inArray(gets.id, leadingGetIds))
    .orderBy(asc(vibes.endsAt))
  const participants = await db
    .select({ vibeId: gets.vibeId, n: sql<number>`count(distinct ${gets.userId})::int` })
    .from(gets)
    .where(and(inArray(gets.vibeId, rows.map((r) => r.vibe.id)), eq(gets.status, 'CONFIRMED')))
    .groupBy(gets.vibeId)
  const pMap = new Map(participants.map((p) => [p.vibeId, Number(p.n)]))
  return rows.map((r) => ({ vibe: r.vibe, product: r.product, myTopGet: r.get, participants: pMap.get(r.vibe.id) ?? 0 }))
}

/** D9: números do card "Meus Gets". won = Champion Gets. */
export async function getsSummary(db: DbOrTx, userId: string) {
  const one = async (q: ReturnType<typeof sql>) => {
    const r = await db.execute(q)
    const row = (r as unknown as { rows: Array<{ n: unknown }> }).rows[0]
    return Number(row?.n ?? 0)
  }
  const [participated, active, won, lost, leading] = await Promise.all([
    one(sql`SELECT count(DISTINCT vibe_id) AS n FROM gets WHERE user_id = ${userId} AND status = 'CONFIRMED'`),
    one(sql`SELECT count(DISTINCT g.vibe_id) AS n FROM gets g JOIN vibes v ON v.id = g.vibe_id
            WHERE g.user_id = ${userId} AND g.status = 'CONFIRMED' AND v.status = 'LIVE'`),
    one(sql`SELECT count(*) AS n FROM vibes v JOIN gets g ON g.id = v.winner_get_id WHERE g.user_id = ${userId}`),
    one(sql`SELECT count(DISTINCT g.vibe_id) AS n FROM gets g JOIN vibes v ON v.id = g.vibe_id
            LEFT JOIN gets w ON w.id = v.winner_get_id
            WHERE g.user_id = ${userId} AND g.status = 'CONFIRMED' AND v.status = 'ENDED'
              AND (w.user_id IS NULL OR w.user_id <> ${userId})`),
    leadingVibes(db, userId).then((l) => l.length),
  ])
  return { participated, active, won, lost, leading }
}
