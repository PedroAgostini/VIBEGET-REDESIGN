import { and, count, desc, eq, inArray, isNull, ne, or, sum, sql } from 'drizzle-orm'
import type { AppContext, RequestMeta } from '../../context.js'
import { auditLogs, authTokens, getcoinLedger, gets, payments, products, sessions, users, vibes, cashLedger, getcoinPurchases, withdrawals, marketListings, marketOrders, prizeDeliveries } from '../../db/schema.js'
import { countOpenPrizes, listMyPrizes } from '../prizes/service.js'
import { audit } from '../../lib/audit.js'
import { hashPassword, randomToken, referralCode, verifyPassword } from '../../lib/crypto.js'
import { AppError, badRequest, conflict, isUniqueViolation, unauthorized } from '../../lib/errors.js'
import { cpfIndex, emailIndex } from '../../lib/field-crypto.js'
import { toNumber } from '../../lib/money.js'
import { maskPixKey, toMe } from '../../lib/presenters.js'
import {
  clearPasswordAttempts,
  registerFailedAttempt,
  reservePasswordAttempt,
  revokeAllSessions,
  tooManyAttempts,
} from '../auth/service.js'
import { getBalance, ledgerPublicColumns } from '../wallet/service.js'
import { cashLedgerPublicColumns, getCashBalance } from '../cash/service.js'
import { getsSummary } from '../gets/service.js'
import { toWithdrawalView } from '../withdrawals/service.js'
import type { UpdateMeInput } from './schemas.js'

export async function dashboard(ctx: AppContext, userId: string) {
  const { db } = ctx
  const [user] = await db.select().from(users).where(eq(users.id, userId))
  if (!user) throw unauthorized()

  const [balanceCents, activeGets, [wins], [cashback], recentMovements] = await Promise.all([
    getBalance(db, userId),
    db
      .select({
        id: gets.id,
        totalCents: gets.totalCents,
        cashCents: gets.cashCents,
        getcoinCents: gets.getcoinCents,
        status: gets.status,
        createdAt: gets.createdAt,
        vibe: { id: vibes.id, slug: vibes.slug, endsAt: vibes.endsAt, minGetCents: vibes.minGetCents },
        product: { name: products.name, imageUrl: products.imageUrl },
      })
      .from(gets)
      .innerJoin(vibes, eq(vibes.id, gets.vibeId))
      .innerJoin(products, eq(products.id, vibes.productId))
      .where(
        and(
          eq(gets.userId, userId),
          inArray(gets.status, ['PENDING_PAYMENT', 'CONFIRMED']),
          eq(vibes.status, 'LIVE'),
        ),
      )
      .orderBy(desc(gets.createdAt))
      .limit(50),
    db
      .select({ n: count() })
      .from(vibes)
      .innerJoin(gets, eq(gets.id, vibes.winnerGetId))
      .where(eq(gets.userId, userId)),
    db
      .select({ total: sum(getcoinLedger.amountCents) })
      .from(getcoinLedger)
      .where(and(eq(getcoinLedger.userId, userId), eq(getcoinLedger.type, 'CASHBACK'))),
    db
      .select(ledgerPublicColumns)
      .from(getcoinLedger)
      .where(eq(getcoinLedger.userId, userId))
      .orderBy(desc(getcoinLedger.createdAt), desc(getcoinLedger.seq))
      .limit(10),
  ])

  return {
    user: toMe(user),
    level: user.level,
    balanceCents,
    activeGets,
    wins: wins?.n ?? 0,
    cashbackReceivedCents: toNumber(cashback?.total),
    recentMovements,
    // D6/D9
    cashBalanceCents: await getCashBalance(db, userId),
    getsSummary: await getsSummary(db, userId),
    referralCode: user.referralCode,
    // D13: prêmios esperando o vencedor confirmar o endereço (aviso no Início)
    prizesAwaitingAddress: (await listMyPrizes(db, userId)).filter((p) => p.status === 'AWAITING_ADDRESS').length,
  }
}

/** Atualiza o próprio perfil. CPF e data de nascimento só podem ser definidos uma vez. */
export async function updateMe(ctx: AppContext, userId: string, input: UpdateMeInput, meta: RequestMeta) {
  const { db } = ctx
  const [user] = await db.select().from(users).where(eq(users.id, userId))
  if (!user) throw unauthorized()

  const patch: Partial<typeof users.$inferInsert> = {}
  if (input.name !== undefined) patch.name = input.name
  if (input.phone !== undefined) patch.phone = input.phone
  if (input.marketingOptIn !== undefined) patch.marketingOptIn = input.marketingOptIn
  if (input.cpf !== undefined) {
    if (user.cpf && user.cpf !== input.cpf) {
      throw conflict('O CPF já foi informado e não pode ser alterado. Fale com o suporte.', 'CPF_LOCKED')
    }
    patch.cpf = input.cpf
    // Índice cego: a unicidade do CPF fica no hash (o CPF em si está cifrado).
    patch.cpfHash = cpfIndex(input.cpf)
  }
  if (input.birthDate !== undefined) {
    if (user.birthDate && user.birthDate !== input.birthDate) {
      throw conflict('A data de nascimento já foi informada e não pode ser alterada.', 'BIRTHDATE_LOCKED')
    }
    patch.birthDate = input.birthDate
  }
  if (Object.keys(patch).length === 0) return toMe(user)

  try {
    const [updated] = await db.update(users).set(patch).where(eq(users.id, userId)).returning()
    await audit(db, {
      actorId: userId,
      action: 'PROFILE_UPDATED',
      entity: 'user',
      entityId: userId,
      metadata: { fields: Object.keys(patch) },
      ip: meta.ip,
    })
    return toMe(updated!)
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict('Este CPF já está em uso por outra conta.', 'CPF_TAKEN')
    throw err
  }
}

/** Exportação LGPD: tudo que guardamos sobre o titular (sem hashes de senha/token). */
export async function exportMyData(ctx: AppContext, userId: string) {
  const { db } = ctx
  const [user] = await db.select().from(users).where(eq(users.id, userId))
  if (!user) throw unauthorized()
  const myGets = await db.select().from(gets).where(eq(gets.userId, userId)).orderBy(desc(gets.createdAt))
  const getIds = myGets.map((g) => g.id)
  const [ledger, myPayments, mySessions, myAudit, balanceCents, byOthers] = await Promise.all([
    db.select(ledgerPublicColumns).from(getcoinLedger).where(eq(getcoinLedger.userId, userId)),
    getIds.length
      ? db
          .select({
            id: payments.id,
            getId: payments.getId,
            method: payments.method,
            status: payments.status,
            amountCents: payments.amountCents,
            paidAt: payments.paidAt,
            createdAt: payments.createdAt,
          })
          .from(payments)
          .where(inArray(payments.getId, getIds))
      : Promise.resolve([]),
    db
      .select({
        id: sessions.id,
        createdAt: sessions.createdAt,
        expiresAt: sessions.expiresAt,
        revokedAt: sessions.revokedAt,
        userAgent: sessions.userAgent,
        ip: sessions.ip,
      })
      .from(sessions)
      .where(eq(sessions.userId, userId)),
    db
      .select({ action: auditLogs.action, entity: auditLogs.entity, createdAt: auditLogs.createdAt, ip: auditLogs.ip })
      .from(auditLogs)
      .where(eq(auditLogs.actorId, userId))
      .orderBy(desc(auditLogs.createdAt)),
    getBalance(db, userId),
    // Ações de terceiros (staff/sistema) sobre o titular: ajustes de carteira, suspensão, mudança de role (QA-15).
    db
      .select({ action: auditLogs.action, createdAt: auditLogs.createdAt, metadata: auditLogs.metadata })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.entity, 'user'),
          eq(auditLogs.entityId, userId),
          or(isNull(auditLogs.actorId), ne(auditLogs.actorId, userId)),
        ),
      )
      .orderBy(desc(auditLogs.createdAt)),
  ])

  return {
    exportedAt: new Date().toISOString(),
    profile: {
      ...toMe(user),
      cpf: user.cpf,
      termsAcceptedAt: user.termsAcceptedAt,
      emailVerifiedAt: user.emailVerifiedAt,
    },
    wallet: { balanceCents, ledger },
    gets: myGets.map(({ idempotencyKey: _k, ...g }) => g),
    payments: myPayments,
    sessions: mySessions,
    activity: myAudit,
    cash: {
      balanceCents: await getCashBalance(db, userId),
      ledger: await db.select(cashLedgerPublicColumns).from(cashLedger).where(eq(cashLedger.userId, userId)),
    },
    withdrawals: (await db.select().from(withdrawals).where(eq(withdrawals.userId, userId))).map(toWithdrawalView),
    market: {
      listings: await db
        .select({
          id: marketListings.id,
          unitPriceCents: marketListings.unitPriceCents,
          totalCents: marketListings.totalCents,
          remainingCents: marketListings.remainingCents,
          status: marketListings.status,
          createdAt: marketListings.createdAt,
        })
        .from(marketListings)
        .where(eq(marketListings.sellerId, userId)),
      orders: await db
        .select({
          id: marketOrders.id,
          role: sql<string>`CASE WHEN ${marketOrders.buyerId} = ${userId} THEN 'BUYER' ELSE 'SELLER' END`,
          getcoinsCents: marketOrders.getcoinsCents,
          totalPriceCents: marketOrders.totalPriceCents,
          feeCents: marketOrders.feeCents,
          status: marketOrders.status,
          createdAt: marketOrders.createdAt,
        })
        .from(marketOrders)
        .where(or(eq(marketOrders.buyerId, userId), eq(marketOrders.sellerId, userId))),
    },
    getcoinPurchases: await db
      .select({
        id: getcoinPurchases.id,
        packageName: getcoinPurchases.packageName,
        getcoinsCents: getcoinPurchases.getcoinsCents,
        bonusCents: getcoinPurchases.bonusCents,
        priceCents: getcoinPurchases.priceCents,
        method: getcoinPurchases.method,
        status: getcoinPurchases.status,
        createdAt: getcoinPurchases.createdAt,
      })
      .from(getcoinPurchases)
      .where(eq(getcoinPurchases.userId, userId)),
    prizes: await listMyPrizes(db, userId),
    actionsByOthers: byOthers,
  }
}

/**
 * Exclusão LGPD: anonimiza dados pessoais e desativa a conta.
 * Registros financeiros (Gets, pagamentos, livro-razão) ficam, sem vínculo com dados pessoais.
 */
export async function deleteMe(ctx: AppContext, userId: string, password: string, meta: RequestMeta) {
  const { db } = ctx
  const [user] = await db.select().from(users).where(eq(users.id, userId))
  if (!user) throw unauthorized()
  // Falhas contam no mesmo limite do login (QA-10).
  const reserved = await reservePasswordAttempt(db, userId)
  if (reserved === null) throw tooManyAttempts()
  if (!(await verifyPassword(user.passwordHash, password))) {
    const locked = await registerFailedAttempt(db, userId, reserved)
    await audit(db, {
      actorId: userId,
      action: locked ? 'ACCOUNT_LOCKED' : 'ACCOUNT_DELETE_FAILED',
      entity: 'user',
      entityId: userId,
      metadata: { reason: 'bad_password', flow: 'delete_account' },
      ip: meta.ip,
    })
    throw badRequest('Senha incorreta.', 'INVALID_PASSWORD')
  }
  await clearPasswordAttempts(db, userId)

  if (user.role === 'ADMIN') {
    const [{ n } = { n: 0 }] = await db
      .select({ n: count() })
      .from(users)
      .where(and(eq(users.role, 'ADMIN'), eq(users.status, 'ACTIVE'), ne(users.id, userId)))
    if (n === 0) throw conflict('O último administrador ativo não pode excluir a conta.', 'LAST_ADMIN')
  }

  const [{ n: openGets } = { n: 0 }] = await db
    .select({ n: count() })
    .from(gets)
    .innerJoin(vibes, eq(vibes.id, gets.vibeId))
    .where(
      and(eq(gets.userId, userId), inArray(gets.status, ['PENDING_PAYMENT', 'CONFIRMED']), eq(vibes.status, 'LIVE')),
    )
  // D6: saldo em R$ é dinheiro do usuário: não pode ser perdido na exclusão.
  const [cashBalance, [{ n: pendingW } = { n: 0 }]] = await Promise.all([
    getCashBalance(db, userId),
    db.select({ n: count() }).from(withdrawals).where(and(eq(withdrawals.userId, userId), eq(withdrawals.status, 'PENDING'))),
  ])
  // D12: anúncio ativo (GetCoin em custódia) ou pedido pendente como comprador/vendedor bloqueia a exclusão.
  const [[{ n: activeListings } = { n: 0 }], [{ n: pendingOrders } = { n: 0 }]] = await Promise.all([
    db.select({ n: count() }).from(marketListings).where(and(eq(marketListings.sellerId, userId), eq(marketListings.status, 'ACTIVE'))),
    db
      .select({ n: count() })
      .from(marketOrders)
      .where(and(or(eq(marketOrders.buyerId, userId), eq(marketOrders.sellerId, userId)), eq(marketOrders.status, 'PENDING_PAYMENT'))),
  ])
  if (activeListings > 0 || pendingOrders > 0) {
    throw new AppError(409, 'MARKET_OPEN', 'Cancele seus anúncios e aguarde os pedidos pendentes antes de excluir a conta.')
  }
  if (cashBalance > 0 || pendingW > 0) {
    throw new AppError(409, 'CASH_BALANCE', 'Você tem saldo em carteira ou saque pendente. Saque o saldo antes de excluir a conta.')
  }
  if (openGets > 0) {
    throw new AppError(
      409,
      'OPEN_GETS',
      'Você tem Gets em Vibes em andamento. Aguarde o encerramento para excluir a conta.',
    )
  }
  // D13: prêmio ainda não entregue seria perdido junto com o endereço.
  if ((await countOpenPrizes(db, userId)) > 0) {
    throw new AppError(409, 'PRIZE_OPEN', 'Você tem um prêmio a receber. Aguarde a entrega para excluir a conta.')
  }

  const unusableHash = await hashPassword(randomToken(48))
  await db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({
        name: 'Conta excluída',
        email: `deleted+${user.id}@deleted.invalid`,
        emailHash: emailIndex(`deleted+${user.id}@deleted.invalid`),
        cpf: null,
        cpfHash: null,
        phone: null,
        birthDate: null,
        passwordHash: unusableHash,
        status: 'DELETED',
        marketingOptIn: false,
        referralCode: `X${referralCode(10)}`,
        deletedAt: new Date(),
        failedLoginCount: 0,
        // D8: endereço também é dado pessoal
        cep: null,
        street: null,
        number: null,
        complement: null,
        district: null,
        city: null,
        state: null,
        lockedUntil: null,
      })
      .where(eq(users.id, userId))
    await revokeAllSessions(tx, userId)
    await tx.delete(authTokens).where(eq(authTokens.userId, userId))
    // Remove dados de rede/dispositivo das sessões antigas.
    await tx.update(sessions).set({ ip: null, userAgent: null }).where(eq(sessions.userId, userId))
    // D6: chave Pix dos saques antigos fica só mascarada (o registro financeiro permanece).
    for (const w of await tx.select().from(withdrawals).where(eq(withdrawals.userId, userId))) {
      await tx.update(withdrawals).set({ pixKey: maskPixKey(w.pixKeyType, w.pixKey) }).where(eq(withdrawals.id, w.id))
    }
    // D13: endereço e telefone de entregas antigas são dado pessoal; a entrega em si (status, rastreio) fica.
    await tx
      .update(prizeDeliveries)
      .set({ recipientName: null, phone: null, cep: null, street: null, number: null, complement: null, district: null, city: null, state: null })
      .where(eq(prizeDeliveries.userId, userId))
    await audit(tx, { actorId: userId, action: 'ACCOUNT_DELETED', entity: 'user', entityId: userId })
    // Anonimiza o IP de todo o histórico de auditoria ligado ao titular (QA-15).
    await tx
      .update(auditLogs)
      .set({ ip: null })
      .where(or(eq(auditLogs.actorId, userId), and(eq(auditLogs.entity, 'user'), eq(auditLogs.entityId, userId))))
  })
}

