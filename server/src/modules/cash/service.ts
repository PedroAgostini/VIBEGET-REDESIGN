import { asc, count, desc, eq, inArray, sql } from 'drizzle-orm'
import type { DbOrTx, Tx } from '../../db/client.js'
import { cashLedger, cashWallets, type CashLedgerType } from '../../db/schema.js'
import { AppError } from '../../lib/errors.js'
import { assertCents } from '../../lib/money.js'
import { offsetOf, paginated, type Pagination } from '../../lib/pagination.js'

export interface CashMovement {
  userId: string
  /** Positivo = crédito, negativo = débito. Centavos de R$, nunca zero. */
  amountCents: number
  type: CashLedgerType
  referenceType?: string | null
  referenceId?: string | null
  reason?: string | null
  createdById?: string | null
}

/**
 * D6 — ÚNICO ponto de alteração do saldo em R$.
 * Precisa de transação: garante a carteira (cria com 0 se não existir), trava a linha (FOR UPDATE),
 * valida saldo, atualiza o cache em cash_wallets e grava o lançamento imutável em cash_ledger.
 * CHECK (balance_cents >= 0) no banco é a última barreira.
 * Ordem de locks do sistema: Vibe -> pagamento/Get/compra/saque -> carteiras GetCoin (por user_id) -> carteiras R$ (por user_id).
 */
export async function applyCashMovement(tx: Tx, m: CashMovement) {
  assertCents(m.amountCents, 'amountCents')
  if (m.amountCents === 0) throw new AppError(400, 'INVALID_AMOUNT', 'O valor não pode ser zero.')

  await tx.insert(cashWallets).values({ userId: m.userId, balanceCents: 0 }).onConflictDoNothing()
  const [wallet] = await tx
    .select({ balanceCents: cashWallets.balanceCents })
    .from(cashWallets)
    .where(eq(cashWallets.userId, m.userId))
    .for('update')
  const newBalance = wallet!.balanceCents + m.amountCents
  if (newBalance < 0) throw new AppError(422, 'INSUFFICIENT_BALANCE', 'Saldo em carteira insuficiente.')

  await tx.update(cashWallets).set({ balanceCents: newBalance }).where(eq(cashWallets.userId, m.userId))
  const [entry] = await tx
    .insert(cashLedger)
    .values({
      userId: m.userId,
      amountCents: m.amountCents,
      balanceAfterCents: newBalance,
      type: m.type,
      referenceType: m.referenceType ?? null,
      referenceId: m.referenceId ?? null,
      reason: m.reason ?? null,
      createdById: m.createdById ?? null,
    })
    .returning()
  return entry!
}

/** Trava várias carteiras R$ de uma vez, em ordem de user_id (usado por settlement/cancelamento). */
export async function lockCashWallets(tx: Tx, userIds: string[]) {
  if (userIds.length === 0) return
  await tx
    .select({ userId: cashWallets.userId })
    .from(cashWallets)
    .where(inArray(cashWallets.userId, userIds))
    .orderBy(asc(cashWallets.userId))
    .for('update')
}

export async function getCashBalance(db: DbOrTx, userId: string): Promise<number> {
  const [w] = await db.select({ b: cashWallets.balanceCents }).from(cashWallets).where(eq(cashWallets.userId, userId))
  return w?.b ?? 0
}

export const cashLedgerPublicColumns = {
  id: cashLedger.id,
  amountCents: cashLedger.amountCents,
  balanceAfterCents: cashLedger.balanceAfterCents,
  type: cashLedger.type,
  referenceType: cashLedger.referenceType,
  referenceId: cashLedger.referenceId,
  reason: cashLedger.reason,
  createdAt: cashLedger.createdAt,
}

export async function listCashLedger(db: DbOrTx, userId: string, p: Pagination) {
  const where = eq(cashLedger.userId, userId)
  const [rows, [{ total } = { total: 0 }]] = await Promise.all([
    db
      .select(cashLedgerPublicColumns)
      .from(cashLedger)
      .where(where)
      .orderBy(desc(cashLedger.createdAt), desc(cashLedger.seq))
      .limit(p.pageSize)
      .offset(offsetOf(p)),
    db.select({ total: count() }).from(cashLedger).where(where),
  ])
  return paginated(rows, total, p)
}

/** Invariante contábil (usado em testes/monitoramento): soma do livro-razão == saldo. */
export async function cashInvariantOk(db: DbOrTx, userId: string) {
  const [{ s } = { s: '0' }] = await db
    .select({ s: sql<string>`coalesce(sum(${cashLedger.amountCents}), 0)` })
    .from(cashLedger)
    .where(eq(cashLedger.userId, userId))
  return Number(s) === (await getCashBalance(db, userId))
}
