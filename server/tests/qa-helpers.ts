/**
 * Utilitários da suíte do QA (complementam helpers.ts do builder).
 */
import { createHmac } from 'node:crypto'
import { eq, sql } from 'drizzle-orm'
import { expect } from 'vitest'
import { gets, payments, wallets } from '../src/db/schema.js'
import { moveGetcoin } from '../src/modules/wallet/service.js'
import { bearer, createTestApp, CSRF, type TestContext } from './helpers.js'

export const API = '/api/v1'

let keySeq = 0
export const idemKey = () => `qa-key-${Date.now()}-${++keySeq}`

export const get = (t: TestContext, url: string, token?: string, headers: Record<string, string> = {}) =>
  t.app.inject({ method: 'GET', url: `${API}${url}`, headers: { ...(token ? bearer(token) : {}), ...headers } })

export const send = (
  t: TestContext,
  method: 'POST' | 'PATCH' | 'DELETE' | 'PUT',
  url: string,
  payload?: unknown,
  headers: Record<string, string> = {},
) =>
  t.app.inject({
    method,
    url: `${API}${url}`,
    headers,
    ...(payload !== undefined ? { payload: payload as object } : {}),
  })

export const authed = (token: string, extra: Record<string, string> = {}) => ({ ...bearer(token), ...extra })
export const withCsrf = (token: string) => ({ ...bearer(token), ...CSRF })

/** Credita GetCoin direto pelo serviço (movimento ADJUSTMENT legítimo do livro-razão). */
export async function fund(t: TestContext, userId: string, cents: number) {
  await moveGetcoin(t.db, { userId, amountCents: cents, type: 'ADJUSTMENT', reason: 'QA: saldo inicial' })
}

export async function balanceOf(t: TestContext, userId: string): Promise<number> {
  const [w] = await t.db.select({ b: wallets.balanceCents }).from(wallets).where(eq(wallets.userId, userId))
  return w?.b ?? 0
}

/** Cria um Get pela API. */
export async function placeGet(
  t: TestContext,
  token: string,
  vibeId: string,
  body: { cashCents: number; getcoinCents?: number; method?: 'PIX' | 'CARD' },
  key: string = idemKey(),
) {
  return t.app.inject({
    method: 'POST',
    url: `${API}/vibes/${vibeId}/gets`,
    headers: { ...bearer(token), 'idempotency-key': key },
    payload: { method: 'PIX', getcoinCents: 0, ...body },
  })
}

export async function externalIdOfGet(t: TestContext, getId: string): Promise<string> {
  const [p] = await t.db.select({ e: payments.externalId }).from(payments).where(eq(payments.getId, getId))
  return p!.e
}

export async function paymentOfGet(t: TestContext, getId: string) {
  const [p] = await t.db.select().from(payments).where(eq(payments.getId, getId))
  return p!
}

export async function getRow(t: TestContext, getId: string) {
  const [g] = await t.db.select().from(gets).where(eq(gets.id, getId))
  return g!
}

export function sign(t: TestContext, raw: string, secret = t.env.PAYMENT_WEBHOOK_SECRET) {
  return createHmac('sha256', secret).update(raw).digest('hex')
}

export async function webhook(t: TestContext, externalId: string, status: 'PAID' | 'FAILED', sig?: string | null) {
  const raw = JSON.stringify({ externalId, status })
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (sig !== null) headers['x-signature'] = sig ?? sign(t, raw)
  return t.app.inject({ method: 'POST', url: `${API}/payments/webhook`, headers, payload: raw })
}

/** Cria Get e confirma o pagamento via webhook assinado. Devolve o id do Get. */
export async function confirmedGet(
  t: TestContext,
  token: string,
  vibeId: string,
  body: { cashCents: number; getcoinCents?: number },
) {
  const res = await placeGet(t, token, vibeId, body)
  expect(res.statusCode, res.body).toBe(201)
  const getId = res.json().data.get.id as string
  const wh = await webhook(t, await externalIdOfGet(t, getId), 'PAID')
  expect(wh.statusCode, wh.body).toBe(200)
  return getId
}

/**
 * Invariante contábil: para TODO usuário, soma do livro-razão == wallets.balance_cents
 * e o balance_after do último lançamento == saldo. Nenhuma carteira negativa.
 */
export async function assertLedgerInvariant(t: TestContext) {
  const r = await t.db.execute(sql`
    SELECT w.user_id, w.balance_cents::bigint AS bal, COALESCE(SUM(l.amount_cents), 0)::bigint AS led
    FROM wallets w LEFT JOIN getcoin_ledger l ON l.user_id = w.user_id
    GROUP BY w.user_id, w.balance_cents
    HAVING w.balance_cents <> COALESCE(SUM(l.amount_cents), 0)
  `)
  const rows = (r as unknown as { rows: unknown[] }).rows
  expect(rows, `livro-razão divergente: ${JSON.stringify(rows)}`).toEqual([])

  const orphan = await t.db.execute(sql`
    SELECT l.user_id FROM getcoin_ledger l LEFT JOIN wallets w ON w.user_id = l.user_id WHERE w.user_id IS NULL LIMIT 1
  `)
  expect((orphan as unknown as { rows: unknown[] }).rows).toEqual([])

  const neg = await t.db.execute(sql`SELECT user_id FROM wallets WHERE balance_cents < 0`)
  expect((neg as unknown as { rows: unknown[] }).rows).toEqual([])

  const chain = await t.db.execute(sql`
    SELECT w.user_id FROM wallets w
    WHERE EXISTS (SELECT 1 FROM getcoin_ledger l WHERE l.user_id = w.user_id)
      AND NOT EXISTS (
        -- lançamentos da mesma transação têm o mesmo created_at (ver QA-18): basta um deles fechar no saldo
        SELECT 1 FROM getcoin_ledger l
        WHERE l.user_id = w.user_id
          AND l.created_at = (SELECT max(created_at) FROM getcoin_ledger x WHERE x.user_id = w.user_id)
          AND l.balance_after_cents = w.balance_cents
      )
  `)
  expect((chain as unknown as { rows: unknown[] }).rows).toEqual([])
}

/**
 * Chaves de dados explícitas para os testes em modo produção. São as MESMAS do ambiente de teste:
 * o keyring da criptografia é global no processo, e trocar a chave no meio de um arquivo deixaria
 * ilegíveis os dados das outras apps abertas nele.
 */
export const DATA_KEYS = {
  DATA_KEY: 'dev-only-insecure-data-key-change-me-0123456789abcdef',
  DATA_INDEX_KEY: 'dev-only-insecure-index-key-change-me-0123456789abcd',
} as const

export const PROD_ENV = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgres://qa:qa@127.0.0.1:5432/qa',
  JWT_SECRET: 'q'.repeat(48),
  PAYMENT_WEBHOOK_SECRET: 'w'.repeat(48),
  COOKIE_SECURE: 'true',
  ...DATA_KEYS,
} as const

/** App em modo produção (banco continua PGlite em memória; só o env muda). */
export const createProdApp = (extra: Record<string, string> = {}) =>
  createTestApp({ env: { ...PROD_ENV, ...extra } })

const b64u = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
export function craftJwt(
  payload: Record<string, unknown>,
  secret: string,
  header: Record<string, unknown> = { alg: 'HS256', typ: 'JWT' },
) {
  const h = b64u(header)
  const p = b64u(payload)
  if (header.alg === 'none') return `${h}.${p}.`
  const s = createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url')
  return `${h}.${p}.${s}`
}

export const decodeJwt = (token: string) =>
  JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()) as Record<string, unknown>
