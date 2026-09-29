/**
 * QA — encerramento (settlement), cancelamento, jobs e invariantes do livro-razão.
 */
import { and, count, eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getcoinLedger, gets, payments, vibes } from '../src/db/schema.js'
import { runScheduledJobs } from '../src/jobs/index.js'
import { cashbackFor } from '../src/lib/money.js'
import { settleVibe } from '../src/modules/vibes/settlement.js'
import { bearer, createLiveVibe, createTestApp, getUserRow, userWithToken, type TestContext } from './helpers.js'
import { assertLedgerInvariant, balanceOf, confirmedGet, fund, get, getRow, placeGet, send } from './qa-helpers.js'

let t: TestContext
let admin: Awaited<ReturnType<typeof userWithToken>>
beforeAll(async () => {
  t = await createTestApp()
  admin = await userWithToken(t, { role: 'ADMIN' })
})
afterAll(async () => {
  await assertLedgerInvariant(t)
  await t.close()
})

const close = (vibeId: string) => send(t, 'POST', `/admin/vibes/${vibeId}/close`, undefined, bearer(admin.accessToken))
const ledgerCount = async () => (await t.db.select({ n: count() }).from(getcoinLedger))[0]!.n
const cashbackOf = async (userId: string) =>
  (await t.db
    .select()
    .from(getcoinLedger)
    .where(and(eq(getcoinLedger.userId, userId), eq(getcoinLedger.type, 'CASHBACK'))))

describe('cashbackFor (unidade)', () => {
  it('floor(cash * pct / 100) e validação de faixa', () => {
    expect(cashbackFor(1000, 40)).toBe(400)
    expect(cashbackFor(999, 40)).toBe(399)
    expect(cashbackFor(1, 40)).toBe(0)
    expect(cashbackFor(1001, 40)).toBe(400)
    expect(cashbackFor(12345, 0)).toBe(0)
    expect(cashbackFor(12345, 100)).toBe(12345)
    expect(() => cashbackFor(100, 101)).toThrow()
    expect(() => cashbackFor(100, -1)).toThrow()
    expect(() => cashbackFor(1.5, 40)).toThrow()
  })
})

describe('settlement', () => {
  it('cenário completo: vencedor = maior total; cashback só sobre o cash de cada Get perdedor; pendentes falham e devolvem GetCoin; vencedor vira VIBER; Vibe ENDED', async () => {
    const { vibe } = await createLiveVibe(t, { minGetCents: 100, cashbackPercent: 40 })
    const w = await userWithToken(t, { name: 'Maria Silva Souza' })
    const l1 = await userWithToken(t)
    const l2 = await userWithToken(t)
    const p = await userWithToken(t)
    await fund(t, l1.id, 1000)
    await fund(t, p.id, 100)

    const wGet = await confirmedGet(t, w.accessToken, vibe.id, { cashCents: 5000 })
    const l1Get = await confirmedGet(t, l1.accessToken, vibe.id, { cashCents: 1001, getcoinCents: 1000 }) // total 2001
    const l2Get = await confirmedGet(t, l2.accessToken, vibe.id, { cashCents: 999 })
    const pending = await placeGet(t, p.accessToken, vibe.id, { cashCents: 9000, getcoinCents: 100 }) // maior, mas não pago
    const pendingId = pending.json().data.get.id
    expect(await balanceOf(t, p.id)).toBe(0)

    const res = await close(vibe.id)
    expect(res.statusCode, res.body).toBe(200)
    const d = res.json().data
    expect(d).toMatchObject({
      alreadySettled: false,
      winnerGetId: wGet,
      winnerUserId: w.id,
      confirmedGets: 3,
      failedPendingGets: 1,
      cashbackIssuedCents: 400 + 399,
    })

    expect(await balanceOf(t, l1.id)).toBe(400) // 1000 gasto; cashback 40% de 1001 (não de 2001)
    expect(await balanceOf(t, l2.id)).toBe(399)
    expect(await balanceOf(t, w.id)).toBe(0) // vencedor não recebe cashback
    expect(await balanceOf(t, p.id)).toBe(100) // GetCoin do pendente devolvido
    const [cb1] = await cashbackOf(l1.id)
    expect(cb1).toMatchObject({ amountCents: 400, referenceType: 'get', referenceId: l1Get })
    expect((await cashbackOf(l2.id))[0]!.referenceId).toBe(l2Get)

    expect((await getRow(t, pendingId)).status).toBe('FAILED')
    const [pp] = await t.db.select().from(payments).where(eq(payments.getId, pendingId))
    expect(pp!.status).toBe('FAILED')

    expect((await getUserRow(t, w.id)).level).toBe('VIBER')
    expect((await getUserRow(t, l1.id)).level).toBe('EXPLORADOR')
    const [v] = await t.db.select().from(vibes).where(eq(vibes.id, vibe.id))
    expect(v).toMatchObject({ status: 'ENDED', winnerGetId: wGet })
    expect(v!.settledAt).toBeInstanceOf(Date)

    const dash = await get(t, '/me/dashboard', w.accessToken)
    expect(dash.json().data).toMatchObject({ wins: 1, level: 'VIBER' })
    const dashL1 = await get(t, '/me/dashboard', l1.accessToken)
    expect(dashL1.json().data.cashbackReceivedCents).toBe(400)

    // exibição pública: só primeiro nome + inicial, sem ids pessoais
    const pub = await get(t, `/vibes/${vibe.slug}`)
    expect(pub.json().data.winner).toEqual({ totalCents: 5000, by: 'Maria S.' })
    expect(pub.body).not.toContain(w.id)
    expect(pub.body).not.toContain(w.email)
    expect(pub.body).not.toContain('Silva')

    // Get depois de encerrada
    expect((await placeGet(t, l2.accessToken, vibe.id, { cashCents: 500 })).statusCode).toBe(409)
    await assertLedgerInvariant(t)
  })

  it('empate no total → vence o Get mais antigo (created_at), independente da ordem de inserção', async () => {
    const { vibe } = await createLiveVibe(t, { minGetCents: 100 })
    const a = await userWithToken(t)
    const b = await userWithToken(t)
    const first = await confirmedGet(t, a.accessToken, vibe.id, { cashCents: 1000 })
    const second = await confirmedGet(t, b.accessToken, vibe.id, { cashCents: 1000 })
    // o inserido depois passa a ser o mais antigo
    await t.db.update(gets).set({ createdAt: new Date(Date.now() - 60_000) }).where(eq(gets.id, second))
    const res = await close(vibe.id)
    expect(res.json().data.winnerGetId).toBe(second)
    expect(await balanceOf(t, a.id)).toBe(400)
    expect(await balanceOf(t, b.id)).toBe(0)
    void first
  })

  it('empate com total igual mas composição diferente (cash vs GetCoin) usa só total_cents para vencer', async () => {
    const { vibe } = await createLiveVibe(t, { minGetCents: 100 })
    const a = await userWithToken(t)
    const b = await userWithToken(t)
    await fund(t, b.id, 500)
    const aGet = await confirmedGet(t, a.accessToken, vibe.id, { cashCents: 1000 })
    await confirmedGet(t, b.accessToken, vibe.id, { cashCents: 500, getcoinCents: 500 })
    const res = await close(vibe.id)
    expect(res.json().data.winnerGetId).toBe(aGet)
    expect(await balanceOf(t, b.id)).toBe(200) // 40% de 500 de cash
  })

  it('idempotente: fechar duas vezes (e em paralelo) não paga cashback em dobro', async () => {
    const { vibe } = await createLiveVibe(t, { minGetCents: 100 })
    const a = await userWithToken(t)
    const b = await userWithToken(t)
    await confirmedGet(t, a.accessToken, vibe.id, { cashCents: 2000 })
    await confirmedGet(t, b.accessToken, vibe.id, { cashCents: 1000 })
    const [r1, r2] = await Promise.all([close(vibe.id), close(vibe.id)])
    expect([r1.statusCode, r2.statusCode]).toEqual([200, 200])
    expect([r1.json().data.alreadySettled, r2.json().data.alreadySettled].sort()).toEqual([false, true])
    const n = await ledgerCount()
    const r3 = await close(vibe.id)
    expect(r3.json().data).toMatchObject({ alreadySettled: true, cashbackIssuedCents: 0, winnerUserId: a.id })
    await settleVibe({ db: t.db }, vibe.id)
    expect(await ledgerCount()).toBe(n)
    expect(await balanceOf(t, b.id)).toBe(400)
    await assertLedgerInvariant(t)
  })

  it('Vibe sem Gets confirmados termina ENDED sem vencedor e sem cashback', async () => {
    const { vibe } = await createLiveVibe(t)
    const res = await close(vibe.id)
    expect(res.json().data).toMatchObject({ winnerGetId: null, winnerUserId: null, confirmedGets: 0, cashbackIssuedCents: 0 })
    const [v] = await t.db.select().from(vibes).where(eq(vibes.id, vibe.id))
    expect(v).toMatchObject({ status: 'ENDED', winnerGetId: null })
    expect(v!.settledAt).not.toBeNull()
  })

  it('só uma Get confirmada: vence, ninguém recebe cashback', async () => {
    const { vibe } = await createLiveVibe(t)
    const a = await userWithToken(t)
    const g = await confirmedGet(t, a.accessToken, vibe.id, { cashCents: 500 })
    const res = await close(vibe.id)
    expect(res.json().data).toMatchObject({ winnerGetId: g, cashbackIssuedCents: 0 })
  })

  it('cashback_percent customizado (25%) e 0% são respeitados', async () => {
    const v25 = (await createLiveVibe(t, { cashbackPercent: 25 })).vibe
    const v0 = (await createLiveVibe(t, { cashbackPercent: 0 })).vibe
    const w = await userWithToken(t)
    const l = await userWithToken(t)
    await confirmedGet(t, w.accessToken, v25.id, { cashCents: 5000 })
    await confirmedGet(t, l.accessToken, v25.id, { cashCents: 1003 })
    await confirmedGet(t, w.accessToken, v0.id, { cashCents: 5000 })
    await confirmedGet(t, l.accessToken, v0.id, { cashCents: 1000 })
    await close(v25.id)
    await close(v0.id)
    expect(await balanceOf(t, l.id)).toBe(250) // floor(1003*25/100)=250; 0% não gera lançamento
    expect(await cashbackOf(l.id)).toHaveLength(1)
  })

  /**
   * [QA-14] resolvido pela decisão D2 do cliente (seção 6.1): o vencedor NÃO recebe cashback em nenhum
   * Get dele na Vibe (nem nos não vencedores). Ajustado pelo builder em 2026-09-25 (antes o teste
   * documentava o comportamento anterior: 400 de cashback para o vencedor).
   */
  it('[QA-14/D2] vencedor não recebe cashback em nenhum Get dele; perdedor recebe por Get', async () => {
    const { vibe } = await createLiveVibe(t)
    const w = await userWithToken(t)
    const l = await userWithToken(t)
    await confirmedGet(t, w.accessToken, vibe.id, { cashCents: 3000 })
    await confirmedGet(t, w.accessToken, vibe.id, { cashCents: 1000 })
    await confirmedGet(t, l.accessToken, vibe.id, { cashCents: 2000 })
    await close(vibe.id)
    expect(await balanceOf(t, w.id)).toBe(0)
    expect(await balanceOf(t, l.id)).toBe(800)
  })

  it('não fecha Vibe que não está LIVE (DRAFT/SCHEDULED → 409; inexistente → 404; cancelada → 409)', async () => {
    const d = (await createLiveVibe(t, { status: 'DRAFT' })).vibe
    const s = (await createLiveVibe(t, { status: 'SCHEDULED' })).vibe
    expect((await close(d.id)).statusCode).toBe(409)
    expect((await close(s.id)).statusCode).toBe(409)
    expect((await close('00000000-0000-4000-8000-000000000000')).statusCode).toBe(404)
    const c = (await createLiveVibe(t)).vibe
    await send(t, 'PATCH', `/admin/vibes/${c.id}`, { status: 'CANCELLED' }, bearer(admin.accessToken))
    expect((await close(c.id)).statusCode).toBe(409)
  })

  it('gera audit VIBE_SETTLED com ator admin', async () => {
    const { vibe } = await createLiveVibe(t)
    await close(vibe.id)
    const logs = await get(t, `/admin/audit-logs?entityId=${vibe.id}&action=VIBE_SETTLED`, admin.accessToken)
    expect(logs.json().data[0]).toMatchObject({ actorId: admin.id, metadata: { trigger: 'admin' } })
  })
})

describe('cancelamento', () => {
  it('cancelar Vibe LIVE: confirmados REFUNDED, pendentes FAILED, todo GetCoin devolvido, sem cashback', async () => {
    const { vibe } = await createLiveVibe(t)
    const a = await userWithToken(t)
    const b = await userWithToken(t)
    await fund(t, a.id, 500)
    await fund(t, b.id, 300)
    const aGet = await confirmedGet(t, a.accessToken, vibe.id, { cashCents: 1000, getcoinCents: 500 })
    const bPend = (await placeGet(t, b.accessToken, vibe.id, { cashCents: 800, getcoinCents: 300 })).json().data.get.id
    const res = await send(t, 'PATCH', `/admin/vibes/${vibe.id}`, { status: 'CANCELLED' }, bearer(admin.accessToken))
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().data.status).toBe('CANCELLED')
    expect((await getRow(t, aGet)).status).toBe('REFUNDED')
    expect((await getRow(t, bPend)).status).toBe('FAILED')
    const [ap] = await t.db.select().from(payments).where(eq(payments.getId, aGet))
    expect(ap!.status).toBe('REFUNDED')
    expect(await balanceOf(t, a.id)).toBe(500)
    expect(await balanceOf(t, b.id)).toBe(300)
    expect(await cashbackOf(a.id)).toHaveLength(0)
    // cancelada é imutável
    expect((await send(t, 'PATCH', `/admin/vibes/${vibe.id}`, { status: 'CANCELLED' }, bearer(admin.accessToken))).statusCode).toBe(409)
    expect((await send(t, 'PATCH', `/admin/vibes/${vibe.id}`, { goalGets: 5 }, bearer(admin.accessToken))).statusCode).toBe(409)
    // some da vitrine pública
    expect((await get(t, `/vibes/${vibe.slug}`)).statusCode).toBe(404)
    await assertLedgerInvariant(t)
  })
})

describe('jobs', () => {
  it('runScheduledJobs: SCHEDULED no horário vira LIVE; LIVE vencida é encerrada; pendente expirado falha', async () => {
    const sched = (await createLiveVibe(t, { status: 'SCHEDULED' })).vibe // starts_at já passou
    const due = (await createLiveVibe(t)).vibe
    const a = await userWithToken(t)
    const b = await userWithToken(t)
    await confirmedGet(t, a.accessToken, due.id, { cashCents: 2000 })
    await confirmedGet(t, b.accessToken, due.id, { cashCents: 1000 })
    const future = new Date(Date.now() + 25 * 3600_000) // depois do ends_at das duas
    await t.db.update(vibes).set({ endsAt: new Date(Date.now() + 48 * 3600_000) }).where(eq(vibes.id, sched.id))
    const r = await runScheduledJobs({ db: t.db, log: t.app.log }, future)
    expect(r.activated).toBeGreaterThanOrEqual(1)
    expect(r.settled).toBeGreaterThanOrEqual(1)
    const [s] = await t.db.select().from(vibes).where(eq(vibes.id, sched.id))
    expect(s!.status).toBe('LIVE')
    const [d] = await t.db.select().from(vibes).where(eq(vibes.id, due.id))
    expect(d!.status).toBe('ENDED')
    expect(await balanceOf(t, b.id)).toBe(400)
    // rodar de novo não paga de novo
    await runScheduledJobs({ db: t.db, log: t.app.log }, future)
    expect(await balanceOf(t, b.id)).toBe(400)
    await assertLedgerInvariant(t)
  })
})

describe('livro-razão imutável', () => {
  it('UPDATE, DELETE direto no banco são bloqueados pela trigger', async () => {
    const u = await userWithToken(t)
    await fund(t, u.id, 10)
    await expect(t.db.execute(sql`UPDATE getcoin_ledger SET amount_cents = 999999 WHERE user_id = ${u.id}`)).rejects.toThrow()
    await expect(t.db.execute(sql`DELETE FROM getcoin_ledger WHERE user_id = ${u.id}`)).rejects.toThrow()
    expect(await balanceOf(t, u.id)).toBe(10)
  })

  /** [QA-12] TRUNCATE não passa pela trigger de linha (BEFORE UPDATE OR DELETE ... FOR EACH ROW). */
  it('[QA-12] TRUNCATE do livro-razão também deveria ser bloqueado', async () => {
    const tmp = await createTestApp()
    try {
      const u = await userWithToken(tmp)
      await fund(tmp, u.id, 10)
      await expect(tmp.db.execute(sql`TRUNCATE getcoin_ledger`)).rejects.toThrow()
    } finally {
      await tmp.close()
    }
  })

  it('CHECK no banco: carteira não fica negativa nem com UPDATE direto', async () => {
    const u = await userWithToken(t)
    await expect(t.db.execute(sql`UPDATE wallets SET balance_cents = -1 WHERE user_id = ${u.id}`)).rejects.toThrow()
  })

  it('CHECK no banco: Get com getcoin > cash ou total incoerente é recusado', async () => {
    const { vibe } = await createLiveVibe(t)
    const u = await userWithToken(t)
    await expect(
      t.db.insert(gets).values({ vibeId: vibe.id, userId: u.id, cashCents: 100, getcoinCents: 101, totalCents: 201, idempotencyKey: 'k-ck-1-xxxx' }),
    ).rejects.toThrow()
    await expect(
      t.db.insert(gets).values({ vibeId: vibe.id, userId: u.id, cashCents: 100, getcoinCents: 0, totalCents: 999, idempotencyKey: 'k-ck-2-xxxx' }),
    ).rejects.toThrow()
  })
})
