import { count, desc, eq } from 'drizzle-orm'
import type { Db, DbOrTx, Tx } from '../../db/client.js'
import { getcoinLedger, wallets, type LedgerType } from '../../db/schema.js'
import { AppError, notFound } from '../../lib/errors.js'
import { assertCents } from '../../lib/money.js'
import { offsetOf, paginated, type Pagination } from '../../lib/pagination.js'

export interface WalletMovement {
  userId: string
  /** Positivo = crédito, negativo = débito. Centavos inteiros, nunca zero. */
  amountCents: number
  type: LedgerType
  referenceType?: string | null
  referenceId?: string | null
  reason?: string | null
  createdById?: string | null
}

/**
 * ÚNICO ponto de alteração de saldo de GetCoin.
 * Precisa rodar dentro de uma transação: trava a linha da carteira (SELECT ... FOR UPDATE),
 * valida saldo, atualiza o cache em `wallets` e grava o lançamento imutável no livro-razão.
 * O CHECK (balance_cents >= 0) no banco é a última barreira.
 */
export async function applyWalletMovement(tx: Tx, m: WalletMovement) {
  assertCents(m.amountCents, 'amountCents')
  if (m.amountCents === 0) throw new AppError(400, 'INVALID_AMOUNT', 'O valor não pode ser zero.')

  const [wallet] = await tx
    .select({ balanceCents: wallets.balanceCents })
    .from(wallets)
    .where(eq(wallets.userId, m.userId))
    .for('update')
  if (!wallet) throw notFound('Carteira não encontrada.', 'WALLET_NOT_FOUND')

  const newBalance = wallet.balanceCents + m.amountCents
  if (newBalance < 0) {
    throw new AppError(422, 'INSUFFICIENT_GETCOIN', 'Saldo de GetCoin insuficiente.')
  }

  await tx.update(wallets).set({ balanceCents: newBalance }).where(eq(wallets.userId, m.userId))
  const [entry] = await tx
    .insert(getcoinLedger)
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

/** Conveniência: abre a transação e aplica o movimento. */
export function moveGetcoin(db: Db, m: WalletMovement) {
  return db.transaction((tx) => applyWalletMovement(tx, m))
}

export async function createWallet(db: DbOrTx, userId: string) {
  await db.insert(wallets).values({ userId, balanceCents: 0 }).onConflictDoNothing()
}

export async function getBalance(db: DbOrTx, userId: string): Promise<number> {
  const [w] = await db.select({ b: wallets.balanceCents }).from(wallets).where(eq(wallets.userId, userId))
  return w?.b ?? 0
}

export const ledgerPublicColumns = {
  id: getcoinLedger.id,
  amountCents: getcoinLedger.amountCents,
  balanceAfterCents: getcoinLedger.balanceAfterCents,
  type: getcoinLedger.type,
  referenceType: getcoinLedger.referenceType,
  referenceId: getcoinLedger.referenceId,
  reason: getcoinLedger.reason,
  createdAt: getcoinLedger.createdAt,
}

export async function listLedger(db: DbOrTx, userId: string, p: Pagination) {
  const [rows, [{ total } = { total: 0 }]] = await Promise.all([
    db
      .select(ledgerPublicColumns)
      .from(getcoinLedger)
      .where(eq(getcoinLedger.userId, userId))
      .orderBy(desc(getcoinLedger.createdAt), desc(getcoinLedger.seq))
      .limit(p.pageSize)
      .offset(offsetOf(p)),
    db.select({ total: count() }).from(getcoinLedger).where(eq(getcoinLedger.userId, userId)),
  ])
  return paginated(rows, total, p)
}
