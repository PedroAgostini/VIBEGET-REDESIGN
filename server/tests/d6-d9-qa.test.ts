/**
 * QA completo das decisões D6–D9.
 *
 * Esta suíte privilegia invariantes de dinheiro, corridas/idempotência, IDOR e
 * privacidade. Os testes de sanidade do builder continuam como smoke tests.
 */
import { Writable } from 'node:stream'
import { and, asc, eq, sql } from 'drizzle-orm'
import pino from 'pino'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp, REDACT_PATHS } from '../src/app.js'
import { loadEnv } from '../src/config/env.js'
import { createDb } from '../src/db/client.js'
import {
  auditLogs,
  cashLedger,
  cashWallets,
  getcoinLedger,
  getcoinPurchases,
  payments,
  withdrawals,
} from '../src/db/schema.js'
import { logCensor } from '../src/lib/log-safety.js'
import { MemoryMailer } from '../src/lib/mailer.js'
import { clearCepCache } from '../src/modules/address/service.js'
import { applyCashMovement } from '../src/modules/cash/service.js'
import { expireStalePayments } from '../src/modules/payments/service.js'
import { moveGetcoin } from '../src/modules/wallet/service.js'
import { bearer, createLiveVibe, createTestApp, userWithToken, type TestContext } from './helpers.js'

let t: TestContext
let admin: Awaited<ReturnType<typeof userWithToken>>

beforeAll(async () => {
  t = await createTestApp()
  admin = await userWithToken(t, { role: 'ADMIN' })
})

afterAll(async () => {
  await assertCashLedgerInvariant()
  await t.close()
})

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
const api = (
  method: Method,
  url: string,
  token?: string,
  payload?: object,
  headers: Record<string, string> = {},
) =>
  t.app.inject({
    method,
    url: `/api/v1${url}`,
    headers: { ...(token ? bearer(token) : {}), ...headers },
    ...(payload !== undefined ? { payload } : {}),
  })

let keySequence = 0
const key = (prefix: string) => `${prefix}-${Date.now()}-${++keySequence}`

const fundCash = (userId: string, cents: number) =>
  t.db.transaction((tx) =>
    applyCashMovement(tx, {
      userId,
      amountCents: cents,
      type: 'ADJUSTMENT',
      reason: 'QA: saldo inicial',
    }),
  )

const fundGetcoin = (userId: string, cents: number) =>
  moveGetcoin(t.db, {
    userId,
    amountCents: cents,
    type: 'ADJUSTMENT',
    reason: 'QA: saldo inicial',
  })

async function createPackage(extra: Record<string, unknown> = {}) {
  const response = await api(
    'POST',
    '/admin/getcoin-packages',
    admin.accessToken,
    {
      name: `Pacote QA ${keySequence + 1}`,
      getcoinsCents: 1_000,
      bonusCents: 200,
      priceCents: 900,
      ...extra,
    },
  )
  expect(response.statusCode, response.body).toBe(201)
  return response.json().data as { id: string }
}

async function cashBalance(userId: string) {
  const [row] = await t.db.select().from(cashWallets).where(eq(cashWallets.userId, userId))
  return row?.balanceCents ?? 0
}

async function getcoinBalance(userId: string) {
  const result = await t.db.execute(sql`SELECT balance_cents AS balance FROM wallets WHERE user_id = ${userId}`)
  return Number((result as unknown as { rows: Array<{ balance: unknown }> }).rows[0]?.balance ?? 0)
}

/**
 * Invariante forte de D6: soma == cache, nenhuma carteira negativa e cada
 * balance_after acompanha exatamente a soma acumulada na ordem contábil.
 */
async function assertCashLedgerInvariant() {
  const walletRows = await t.db.select().from(cashWallets)
  const entries = await t.db
    .select()
    .from(cashLedger)
    .orderBy(asc(cashLedger.userId), asc(cashLedger.createdAt), asc(cashLedger.seq))
  const byUser = new Map<string, typeof entries>()
  for (const entry of entries) {
    const list = byUser.get(entry.userId) ?? []
    list.push(entry)
    byUser.set(entry.userId, list)
  }
  for (const wallet of walletRows) {
    expect(wallet.balanceCents, `saldo negativo de ${wallet.userId}`).toBeGreaterThanOrEqual(0)
    let running = 0
    for (const entry of byUser.get(wallet.userId) ?? []) {
      running += entry.amountCents
      expect(entry.balanceAfterCents, `encadeamento quebrado em ${entry.id}`).toBe(running)
    }
    expect(running, `soma do cash_ledger diverge de ${wallet.userId}`).toBe(wallet.balanceCents)
  }
  const orphan = await t.db.execute(sql`
    SELECT l.user_id FROM cash_ledger l
    LEFT JOIN cash_wallets w ON w.user_id = l.user_id
    WHERE w.user_id IS NULL LIMIT 1
  `)
  expect((orphan as unknown as { rows: unknown[] }).rows).toEqual([])
}

describe('D6 — carteira R$, saques e Get com saldo', () => {
  it('mantém o livro-razão imutável por UPDATE, DELETE e TRUNCATE CASCADE', async () => {
    const user = await userWithToken(t)
    await fundCash(user.id, 2_000)
    const [entry] = await t.db.select().from(cashLedger).where(eq(cashLedger.userId, user.id))
    await expect(t.db.update(cashLedger).set({ amountCents: 1 }).where(eq(cashLedger.id, entry!.id))).rejects.toThrow()
    await expect(t.db.delete(cashLedger).where(eq(cashLedger.id, entry!.id))).rejects.toThrow()
    await expect(t.db.execute(sql`TRUNCATE cash_ledger CASCADE`)).rejects.toThrow()
    await assertCashLedgerInvariant()
  })

  it('serializa saques paralelos contra o limite diário', async () => {
    const user = await userWithToken(t)
    await fundCash(user.id, 5_000)
    const settings = await api('PATCH', '/admin/settings/withdrawals', admin.accessToken, {
      withdrawMinCents: 1_000,
      withdrawDailyMaxCents: 2_500,
    })
    expect(settings.statusCode, settings.body).toBe(200)

    const request = (idem: string) =>
      api(
        'POST',
        '/me/withdrawals',
        user.accessToken,
        { amountCents: 1_500, pixKeyType: 'EMAIL', pixKey: 'limite@qa.dev' },
        { 'idempotency-key': idem },
      )
    const responses = await Promise.all([request(key('withdraw-race-a')), request(key('withdraw-race-b'))])
    expect(responses.map((r) => r.statusCode).sort()).toEqual([201, 422])
    expect(responses.find((r) => r.statusCode === 422)?.json().error.code).toBe('WITHDRAW_DAILY_LIMIT')
    const rows = await t.db.select().from(withdrawals).where(eq(withdrawals.userId, user.id))
    expect(rows).toHaveLength(1)
    expect(await cashBalance(user.id)).toBe(3_500)
    await assertCashLedgerInvariant()

    const restore = await api('PATCH', '/admin/settings/withdrawals', admin.accessToken, {
      withdrawMinCents: 1_000,
      withdrawDailyMaxCents: 500_000,
    })
    expect(restore.statusCode, restore.body).toBe(200)
  })

  it('faz replay concorrente do saque sem segunda reserva de saldo', async () => {
    const user = await userWithToken(t)
    await fundCash(user.id, 4_000)
    const idem = key('withdraw-idem')
    const request = () =>
      api(
        'POST',
        '/me/withdrawals',
        user.accessToken,
        { amountCents: 1_000, pixKeyType: 'PHONE', pixKey: '(11) 99999-0000' },
        { 'idempotency-key': idem },
      )
    const responses = await Promise.all([request(), request()])
    expect(responses.map((r) => r.statusCode).sort()).toEqual([200, 201])
    expect(new Set(responses.map((r) => r.json().data.id)).size).toBe(1)
    expect(await cashBalance(user.id)).toBe(3_000)
    const debits = await t.db
      .select()
      .from(cashLedger)
      .where(and(eq(cashLedger.userId, user.id), eq(cashLedger.type, 'WITHDRAWAL')))
    expect(debits).toHaveLength(1)
  })

  it('não expõe a chave Pix ao USER, SUPPORT, exportação LGPD, audit ou log', async () => {
    const rawKey = 'segredo.pix@qa.dev'
    const user = await userWithToken(t)
    const support = await userWithToken(t, { role: 'SUPPORT' })
    await fundCash(user.id, 2_000)
    const created = await api(
      'POST',
      '/me/withdrawals',
      user.accessToken,
      { amountCents: 1_000, pixKeyType: 'EMAIL', pixKey: rawKey },
      { 'idempotency-key': key('withdraw-private') },
    )
    expect(created.statusCode, created.body).toBe(201)
    expect(created.body).not.toContain(rawKey)
    expect((await api('GET', '/me/withdrawals', user.accessToken)).body).not.toContain(rawKey)
    expect((await api('GET', `/admin/withdrawals?userId=${user.id}`, support.accessToken)).body).not.toContain(rawKey)
    expect((await api('GET', '/me/export', user.accessToken)).body).not.toContain(rawKey)

    const audits = await t.db.select().from(auditLogs).where(eq(auditLogs.entityId, created.json().data.id))
    expect(JSON.stringify(audits)).not.toContain(rawKey)

    const lines: string[] = []
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        lines.push(chunk.toString())
        callback()
      },
    })
    const logger = pino({ redact: { paths: REDACT_PATHS, censor: logCensor } }, stream)
    logger.info({ body: { pixKey: rawKey } }, 'requisição de saque')
    expect(lines.join('')).not.toContain(rawKey)
  })

  it('Get BALANCE devolve R$ e GetCoin exatamente uma vez ao cancelar a Vibe', async () => {
    const user = await userWithToken(t)
    const { vibe } = await createLiveVibe(t)
    await fundCash(user.id, 2_000)
    await fundGetcoin(user.id, 600)
    const created = await api(
      'POST',
      `/vibes/${vibe.id}/gets`,
      user.accessToken,
      { cashCents: 600, getcoinCents: 600, method: 'BALANCE' },
      { 'idempotency-key': key('get-balance') },
    )
    expect(created.statusCode, created.body).toBe(201)
    expect(await cashBalance(user.id)).toBe(1_400)
    expect(await getcoinBalance(user.id)).toBe(0)

    const cancelled = await api('PATCH', `/admin/vibes/${vibe.id}`, admin.accessToken, { status: 'CANCELLED' })
    expect(cancelled.statusCode, cancelled.body).toBe(200)
    expect(await cashBalance(user.id)).toBe(2_000)
    expect(await getcoinBalance(user.id)).toBe(600)
    expect((await api('PATCH', `/admin/vibes/${vibe.id}`, admin.accessToken, { status: 'CANCELLED' })).statusCode).toBe(409)

    const cashRefunds = await t.db
      .select()
      .from(cashLedger)
      .where(and(eq(cashLedger.userId, user.id), eq(cashLedger.type, 'REFUND')))
    const coinRefunds = await t.db
      .select()
      .from(getcoinLedger)
      .where(and(eq(getcoinLedger.userId, user.id), eq(getcoinLedger.type, 'REFUND')))
    expect(cashRefunds).toHaveLength(1)
    expect(coinRefunds).toHaveLength(1)
    await assertCashLedgerInvariant()
  })

  it('bloqueia exclusão de conta com saldo em R$ ou saque pendente', async () => {
    const user = await userWithToken(t)
    await fundCash(user.id, 1_000)
    const blocked = await api('DELETE', '/me', user.accessToken, { password: user.password })
    expect(blocked.statusCode).toBe(409)
    expect(blocked.json().error.code).toBe('CASH_BALANCE')
  })
})

describe('D7 — compra de GetCoin', () => {
  it('faz compra BALANCE concorrente idempotente com um único débito e um único crédito', async () => {
    const pkg = await createPackage()
    const user = await userWithToken(t)
    await fundCash(user.id, 2_000)
    const idem = key('purchase-race')
    const request = () =>
      api(
        'POST',
        '/me/getcoin-purchases',
        user.accessToken,
        { packageId: pkg.id, method: 'BALANCE' },
        { 'idempotency-key': idem },
      )
    const responses = await Promise.all([request(), request()])
    expect(responses.map((r) => r.statusCode).sort()).toEqual([200, 201])
    expect(new Set(responses.map((r) => r.json().data.id)).size).toBe(1)
    expect(await cashBalance(user.id)).toBe(1_100)
    expect(await getcoinBalance(user.id)).toBe(1_200)
    const rows = await t.db.select().from(getcoinPurchases).where(eq(getcoinPurchases.userId, user.id))
    expect(rows).toHaveLength(1)
    await assertCashLedgerInvariant()
  })

  it('recusa a mesma Idempotency-Key com dados diferentes', async () => {
    const pkg = await createPackage()
    const user = await userWithToken(t)
    const idem = key('purchase-conflict')
    expect(
      (await api('POST', '/me/getcoin-purchases', user.accessToken, { packageId: pkg.id, method: 'PIX' }, { 'idempotency-key': idem }))
        .statusCode,
    ).toBe(201)
    const conflict = await api(
      'POST',
      '/me/getcoin-purchases',
      user.accessToken,
      { packageId: pkg.id, method: 'CARD' },
      { 'idempotency-key': idem },
    )
    expect(conflict.statusCode).toBe(409)
    expect(conflict.json().error.code).toBe('IDEMPOTENCY_KEY_REUSED')
  })

  it('credita uma só vez quando duas confirmações PAID concorrem', async () => {
    const pkg = await createPackage()
    const user = await userWithToken(t)
    const created = await api(
      'POST',
      '/me/getcoin-purchases',
      user.accessToken,
      { packageId: pkg.id, method: 'PIX' },
      { 'idempotency-key': key('purchase-paid-race') },
    )
    const paymentId = created.json().data.payment.id as string
    const results = await Promise.all([
      api('POST', `/payments/${paymentId}/simulate`, user.accessToken, { status: 'PAID' }),
      api('POST', `/payments/${paymentId}/simulate`, user.accessToken, { status: 'PAID' }),
    ])
    expect(results.map((r) => r.statusCode)).toEqual([200, 200])
    expect(results.map((r) => r.json().changed).sort()).toEqual([false, true])
    expect(await getcoinBalance(user.id)).toBe(1_200)
    const credits = await t.db
      .select()
      .from(getcoinLedger)
      .where(and(eq(getcoinLedger.userId, user.id), eq(getcoinLedger.referenceId, created.json().data.id)))
    expect(credits.map((row) => row.type).sort()).toEqual(['PURCHASE', 'PURCHASE_BONUS'])
  })

  it('estorna PAID tardio de compra sem creditar GetCoin, inclusive após expiração pelo job', async () => {
    const pkg = await createPackage()
    const user = await userWithToken(t)
    const created = await api(
      'POST',
      '/me/getcoin-purchases',
      user.accessToken,
      { packageId: pkg.id, method: 'PIX' },
      { 'idempotency-key': key('purchase-late') },
    )
    const purchaseId = created.json().data.id as string
    const paymentId = created.json().data.payment.id as string
    await t.db.update(payments).set({ expiresAt: new Date(Date.now() - 5_000) }).where(eq(payments.id, paymentId))
    expect(await expireStalePayments({ db: t.db }, new Date())).toBeGreaterThanOrEqual(1)

    const late = await api('POST', `/payments/${paymentId}/simulate`, user.accessToken, { status: 'PAID' })
    expect(late.statusCode, late.body).toBe(200)
    expect(late.json()).toMatchObject({ changed: true, data: { status: 'REFUNDED' } })
    expect(await getcoinBalance(user.id)).toBe(0)
    const [purchase] = await t.db.select().from(getcoinPurchases).where(eq(getcoinPurchases.id, purchaseId))
    expect(purchase?.status).toBe('REFUNDED')
    expect((await api('POST', `/payments/${paymentId}/simulate`, user.accessToken, { status: 'PAID' })).json().changed).toBe(false)
    const refundEvents = await t.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, paymentId), eq(auditLogs.action, 'PROVIDER_REFUND_REQUESTED')))
    expect(refundEvents).toHaveLength(1)
  })

  it('preserva o snapshot do pacote após edição administrativa', async () => {
    const pkg = await createPackage({ name: 'Pacote Snapshot', priceCents: 800 })
    const user = await userWithToken(t)
    const created = await api(
      'POST',
      '/me/getcoin-purchases',
      user.accessToken,
      { packageId: pkg.id, method: 'CARD' },
      { 'idempotency-key': key('purchase-snapshot') },
    )
    expect(created.statusCode, created.body).toBe(201)
    expect((await api('PATCH', `/admin/getcoin-packages/${pkg.id}`, admin.accessToken, { name: 'Novo nome', priceCents: 1_500 })).statusCode).toBe(200)
    const loaded = await api('GET', `/me/getcoin-purchases/${created.json().data.id}`, user.accessToken)
    expect(loaded.json().data.package).toMatchObject({ name: 'Pacote Snapshot', priceCents: 800 })
  })

  it('impede IDOR na compra e na simulação do pagamento', async () => {
    const pkg = await createPackage()
    const owner = await userWithToken(t)
    const other = await userWithToken(t)
    const support = await userWithToken(t, { role: 'SUPPORT' })
    const created = await api(
      'POST',
      '/me/getcoin-purchases',
      owner.accessToken,
      { packageId: pkg.id, method: 'PIX' },
      { 'idempotency-key': key('purchase-idor') },
    )
    const purchaseId = created.json().data.id as string
    const paymentId = created.json().data.payment.id as string
    expect((await api('GET', `/me/getcoin-purchases/${purchaseId}`, other.accessToken)).statusCode).toBe(404)
    expect((await api('POST', `/payments/${paymentId}/simulate`, other.accessToken, { status: 'PAID' })).statusCode).toBe(404)
    expect((await api('POST', `/payments/${paymentId}/simulate`, support.accessToken, { status: 'PAID' })).statusCode).toBe(404)
    const list = await api('GET', '/me/getcoin-purchases', other.accessToken)
    expect(list.json().data).toEqual([])
    const [payment] = await t.db.select().from(payments).where(eq(payments.id, paymentId))
    expect(payment?.status).toBe('PENDING')
  })

  it('mantém a constraint de exatamente um alvo por pagamento', async () => {
    await expect(
      t.db.insert(payments).values({
        provider: 'MOCK',
        method: 'PIX',
        status: 'PENDING',
        amountCents: 100,
        externalId: key('orphan-payment'),
        expiresAt: new Date(Date.now() + 60_000),
      }),
    ).rejects.toThrow()
  })
})

describe('D8 — endereço e proxy de CEP', () => {
  async function withCepApp(fetchImpl: (url: string, init?: unknown) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>) {
    clearCepCache()
    const handle = await createDb({ pgliteDataDir: null })
    await handle.migrate()
    const app = await buildApp({
      db: handle.db,
      env: loadEnv({ NODE_ENV: 'test' }),
      mailer: new MemoryMailer(),
      logger: false,
      rateLimit: false,
      fetch: fetchImpl,
    })
    await app.ready()
    return {
      app,
      close: async () => {
        await app.close()
        await handle.close()
        clearCepCache()
      },
    }
  }

  it('retorna 503 quando os dois provedores estão fora do ar e tenta novamente depois', async () => {
    let calls = 0
    const c = await withCepApp(async () => {
      calls += 1
      throw new Error('provedor fora do ar')
    })
    try {
      const first = await c.app.inject({ method: 'GET', url: '/api/v1/cep/70040900' })
      const second = await c.app.inject({ method: 'GET', url: '/api/v1/cep/70040900' })
      expect(first.statusCode).toBe(503)
      expect(first.json().error.code).toBe('CEP_UNAVAILABLE')
      expect(second.statusCode).toBe(503)
      expect(calls).toBe(4)
    } finally {
      await c.close()
    }
  })

  it('[QA-22] trata resposta 200 malformada como falha e usa o provedor de backup', async () => {
    const calls: string[] = []
    const c = await withCepApp(async (url) => {
      calls.push(url)
      if (url.includes('viacep')) return { ok: true, status: 200, json: async () => ({ mensagem: 'formato inesperado' }) }
      return {
        ok: true,
        status: 200,
        json: async () => ({ cep: '30140071', street: 'Rua dos Timbiras', neighborhood: 'Funcionários', city: 'Belo Horizonte', state: 'MG' }),
      }
    })
    try {
      const response = await c.app.inject({ method: 'GET', url: '/api/v1/cep/30140071' })
      expect(response.statusCode, response.body).toBe(200)
      expect(response.json().data).toEqual({
        cep: '30140071',
        street: 'Rua dos Timbiras',
        district: 'Funcionários',
        city: 'Belo Horizonte',
        state: 'MG',
      })
      expect(calls).toHaveLength(2)
    } finally {
      await c.close()
    }
  })

  it('cacheia CEP inexistente sem consultar novamente', async () => {
    let calls = 0
    const c = await withCepApp(async (url) => {
      calls += 1
      if (url.includes('viacep')) return { ok: false, status: 500, json: async () => ({}) }
      return { ok: false, status: 404, json: async () => ({ message: 'not found' }) }
    })
    try {
      expect((await c.app.inject({ method: 'GET', url: '/api/v1/cep/99999999' })).statusCode).toBe(404)
      expect((await c.app.inject({ method: 'GET', url: '/api/v1/cep/99999999' })).statusCode).toBe(404)
      expect(calls).toBe(2)
    } finally {
      await c.close()
    }
  })
})

describe('D9 — Meus Gets', () => {
  it('aplica desempate pelo Get mais antigo e conta apenas participantes confirmados', async () => {
    const first = await userWithToken(t, { name: 'Primeiro Líder' })
    const tied = await userWithToken(t, { name: 'Segundo Empatado' })
    const pending = await userWithToken(t, { name: 'Participante Pendente' })
    const { vibe } = await createLiveVibe(t)
    await fundCash(first.id, 2_000)
    await fundCash(tied.id, 2_000)

    const firstGet = await api(
      'POST',
      `/vibes/${vibe.id}/gets`,
      first.accessToken,
      { cashCents: 1_000, getcoinCents: 0, method: 'BALANCE' },
      { 'idempotency-key': key('d9-first') },
    )
    expect(firstGet.statusCode, firstGet.body).toBe(201)
    const tiedGet = await api(
      'POST',
      `/vibes/${vibe.id}/gets`,
      tied.accessToken,
      { cashCents: 1_000, getcoinCents: 0, method: 'BALANCE' },
      { 'idempotency-key': key('d9-tied') },
    )
    expect(tiedGet.statusCode, tiedGet.body).toBe(201)
    const pendingGet = await api(
      'POST',
      `/vibes/${vibe.id}/gets`,
      pending.accessToken,
      { cashCents: 1_500, getcoinCents: 0, method: 'PIX' },
      { 'idempotency-key': key('d9-pending') },
    )
    expect(pendingGet.statusCode, pendingGet.body).toBe(201)

    const leading = await api('GET', '/me/gets/leading', first.accessToken)
    expect(leading.statusCode, leading.body).toBe(200)
    expect(leading.json().data).toHaveLength(1)
    expect(leading.json().data[0]).toMatchObject({ participants: 2, myTopGet: { id: firstGet.json().data.get.id } })
    expect(leading.body).not.toContain('Segundo Empatado')
    expect(leading.body).not.toContain('Participante Pendente')
    expect((await api('GET', '/me/gets/leading', tied.accessToken)).json().data).toEqual([])

    const summary = await api('GET', '/me/gets/summary', first.accessToken)
    expect(summary.json().data).toEqual({ participated: 1, active: 1, won: 0, lost: 0, leading: 1 })
  })

  it('conta Vibes distintas, não Gets, e marca somente o Get líder', async () => {
    const user = await userWithToken(t)
    const { vibe } = await createLiveVibe(t)
    await fundCash(user.id, 4_000)
    const low = await api(
      'POST',
      `/vibes/${vibe.id}/gets`,
      user.accessToken,
      { cashCents: 700, getcoinCents: 0, method: 'BALANCE' },
      { 'idempotency-key': key('d9-low') },
    )
    const high = await api(
      'POST',
      `/vibes/${vibe.id}/gets`,
      user.accessToken,
      { cashCents: 900, getcoinCents: 0, method: 'BALANCE' },
      { 'idempotency-key': key('d9-high') },
    )
    expect(low.statusCode).toBe(201)
    expect(high.statusCode).toBe(201)
    expect((await api('GET', '/me/gets/summary', user.accessToken)).json().data.participated).toBe(1)
    const list = await api('GET', '/me/gets', user.accessToken)
    const rows = list.json().data as Array<{ id: string; isLeading: boolean }>
    expect(rows.find((row) => row.id === high.json().data.get.id)?.isLeading).toBe(true)
    expect(rows.find((row) => row.id === low.json().data.get.id)?.isLeading).toBe(false)
  })
})
