/** Todo valor monetário do sistema é inteiro em centavos. GetCoin é 1:1 com centavo de R$. */

export function assertCents(value: number, field = 'valor'): number {
  if (!Number.isSafeInteger(value)) throw new TypeError(`${field} deve ser inteiro em centavos`)
  return value
}

/** Cashback em GetCoin para um Get perdedor: floor(cash * pct / 100). Só a parte paga em R$ conta. */
export function cashbackFor(cashCents: number, cashbackPercent: number): number {
  assertCents(cashCents, 'cashCents')
  if (!Number.isInteger(cashbackPercent) || cashbackPercent < 0 || cashbackPercent > 100) {
    throw new RangeError('cashbackPercent fora de 0..100')
  }
  return Math.floor((cashCents * cashbackPercent) / 100)
}

export const formatBRL = (cents: number) =>
  (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })

/** Converte resultado de SUM/COUNT (string/bigint/null) para number. */
export const toNumber = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v))
