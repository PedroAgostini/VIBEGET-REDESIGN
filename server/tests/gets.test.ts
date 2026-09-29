/**
 * QA — POST /vibes/:id/gets: regras 6.1–6.4, elegibilidade, GetCoin e Idempotency-Key.
 */
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getcoinLedger, gets, payments, vibes } from '../src/db/schema.js'
import { bearer, createLiveVibe, createTestApp, userWithToken, type TestContext } from './helpers.js'
import { assertLedgerInvariant, balanceOf, fund, getRow, idemKey, placeGet } from './qa-helpers.js'

let t: TestContext
beforeAll(async () => {
  t = await createTestApp()
})
afterAll(async () => {
  await assertLedgerInvariant(t)
  await t.close()
})

const yearsAgo = (y: number, extraDays = 0) => {
  const d = new Date()
  d.setUTCFullYear(d.getUTCFullYear() - y)
  d.setUTCDate(d.getUTCDate() + extraDays)
  return d.toISOString().slice(0, 10)
}

describe('regras de valor', () => {
  it('Get válido: 201, PENDING_PAYMENT, total = cash + getcoin, pagamento PIX pendente com copia-e-cola e expiração', async () => {
    const { vibe } = await createLiveVibe(t)
    const u = await userWithToken(t)
    await fund(t, u.id, 1000)
    const res = await placeGet(t, u.accessToken, vibe.id, { cashCents: 500, getcoinCents: 300 })
    expect(res.statusCode, res.body).toBe(201)
    const { get, payment, replayed } = res.json().data
    expect(replayed).toBe(false)
    expect(get).toMatchObject({ cashCents: 500, getcoinCents: 300, totalCents: 800, status: 'PENDING_PAYMENT' })
    expect(payment).toMatchObject({ status: 'PENDING', method: 'PIX', amountCents: 500, provider: 'MOCK' })
    expect(payment.pixCopyPaste).toMatch(/NAO-PAGAVEL/)
    expect(new Date(payment.expiresAt).getTime() - Date.now()).toBeGreaterThan(29 * 60_000)
    // não expõe idempotency key nem externalId
    expect(res.body).not.toMatch(/idempotency|externalId/i)
  })

  it('CARD não gera copia-e-cola', async () => {
    const { vibe } = await createLiveVibe(t)
    const u = await userWithToken(t)
    const res = await placeGet(t, u.accessToken, vibe.id, { cashCents: 500, method: 'CARD' })
    expect(res.statusCode).toBe(201)
    expect(res.json().data.payment.pixCopyPaste).toBeNull()
  })

  it('getcoin > cash → 400; getcoin == cash é aceito', async () => {
    const { vibe } = await createLiveVibe(t)
    const u = await userWithToken(t)
    await fund(t, u.id, 5000)
    const bad = await placeGet(t, u.accessToken, vibe.id, { cashCents: 400, getcoinCents: 401 })
    expect(bad.statusCode).toBe(400)
    expect(bad.json().error.details[0].path).toBe('getcoinCents')
    const ok = await placeGet(t, u.accessToken, vibe.id, { cashCents: 400, getcoinCents: 400 })
    expect(ok.statusCode).toBe(201)
  })

  it('total < min_get → 422 GET_BELOW_MINIMUM; total == min é aceito (GetCoin conta para o mínimo)', async () => {
    const { vibe } = await createLiveVibe(t, { minGetCents: 1000 })
    const u = await userWithToken(t)
    await fund(t, u.id, 5000)
    const low = await placeGet(t, u.accessToken, vibe.id, { cashCents: 999 })
    expect(low.statusCode).toBe(422)
    expect(low.json().error.code).toBe('GET_BELOW_MINIMUM')
    expect((await placeGet(t, u.accessToken, vibe.id, { cashCents: 500, getcoinCents: 500 })).statusCode).toBe(201)
  })

  it.each([
    ['cash zero', { cashCents: 0 }],
    ['cash negativo', { cashCents: -100 }],
    ['cash fracionado', { cashCents: 100.5 }],
    ['cash string', { cashCents: '500' }],
    ['getcoin negativo', { cashCents: 500, getcoinCents: -1 }],
    ['acima do teto de sanidade', { cashCents: 100_000_01 }],
    ['método inválido', { cashCents: 500, method: 'BOLETO' }],
    ['campo extra userId', { cashCents: 500, userId: '00000000-0000-4000-8000-000000000000' }],
    ['campo extra status', { cashCents: 500, status: 'CONFIRMED' }],
    ['campo extra totalCents', { cashCents: 500, totalCents: 999999 }],
  ])('%s → 400', async (_l, body) => {
    const { vibe } = await createLiveVibe(t)
    const u = await userWithToken(t)
    const res = await placeGet(t, u.accessToken, vibe.id, body as never)
    expect(res.statusCode, res.body).toBe(400)
  })

  it('vibe inexistente → 404; id não-uuid → 400', async () => {
    const u = await userWithToken(t)
    expect((await placeGet(t, u.accessToken, '00000000-0000-4000-8000-000000000000', { cashCents: 500 })).statusCode).toBe(404)
    expect((await placeGet(t, u.accessToken, 'abc', { cashCents: 500 })).statusCode).toBe(400)
  })
})

describe('estado e prazo da Vibe', () => {
  it.each(['DRAFT', 'SCHEDULED'] as const)('Vibe %s → 409 VIBE_NOT_LIVE', async (status) => {
    const { vibe } = await createLiveVibe(t, { status })
    const u = await userWithToken(t)
    const res = await placeGet(t, u.accessToken, vibe.id, { cashCents: 500 })
    expect(res.statusCode).toBe(409)
    expect(res.json().error.code).toBe('VIBE_NOT_LIVE')
  })

  it.each(['ENDED', 'CANCELLED'] as const)('Vibe %s → 409', async (status) => {
    const { vibe } = await createLiveVibe(t)
    await t.db.update(vibes).set({ status }).where(eq(vibes.id, vibe.id))
    const u = await userWithToken(t)
    expect((await placeGet(t, u.accessToken, vibe.id, { cashCents: 500 })).statusCode).toBe(409)
  })

  it('LIVE mas antes de starts_at → 409', async () => {
    const { vibe } = await createLiveVibe(t)
    await t.db
      .update(vibes)
      .set({ startsAt: new Date(Date.now() + 3600_000), endsAt: new Date(Date.now() + 7200_000) })
      .where(eq(vibes.id, vibe.id))
    const u = await userWithToken(t)
    expect((await placeGet(t, u.accessToken, vibe.id, { cashCents: 500 })).statusCode).toBe(409)
  })

  it('LIVE mas depois de ends_at (job ainda não encerrou) → 409 e nenhum GetCoin debitado', async () => {
    const { vibe } = await createLiveVibe(t)
    await t.db
      .update(vibes)
      .set({ startsAt: new Date(Date.now() - 7200_000), endsAt: new Date(Date.now() - 1000) })
      .where(eq(vibes.id, vibe.id))
    const u = await userWithToken(t)
    await fund(t, u.id, 500)
    expect((await placeGet(t, u.accessToken, vibe.id, { cashCents: 500, getcoinCents: 200 })).statusCode).toBe(409)
    expect(await balanceOf(t, u.id)).toBe(500)
  })
})

describe('elegibilidade do usuário', () => {
  it('e-mail não verificado → 403 EMAIL_NOT_VERIFIED', async () => {
    const { vibe } = await createLiveVibe(t)
    const u = await userWithToken(t, { verified: false })
    const res = await placeGet(t, u.accessToken, vibe.id, { cashCents: 500 })
    expect(res.statusCode).toBe(403)
    expect(res.json().error.code).toBe('EMAIL_NOT_VERIFIED')
  })

  it('sem CPF → 422 CPF_REQUIRED', async () => {
    const { vibe } = await createLiveVibe(t)
    const u = await userWithToken(t, { cpf: null })
    const res = await placeGet(t, u.accessToken, vibe.id, { cashCents: 500 })
    expect(res.statusCode).toBe(422)
    expect(res.json().error.code).toBe('CPF_REQUIRED')
  })

  it('sem data de nascimento → 422 BIRTHDATE_REQUIRED', async () => {
    const { vibe } = await createLiveVibe(t)
    const u = await userWithToken(t, { birthDate: null })
    expect((await placeGet(t, u.accessToken, vibe.id, { cashCents: 500 })).json().error.code).toBe('BIRTHDATE_REQUIRED')
  })

  it('menor de 18 (faz 18 amanhã) → 403 UNDERAGE; 18 anos completos hoje → 201', async () => {
    const { vibe } = await createLiveVibe(t)
    const minor = await userWithToken(t, { birthDate: yearsAgo(18, 1) })
    const res = await placeGet(t, minor.accessToken, vibe.id, { cashCents: 500 })
    expect(res.statusCode).toBe(403)
    expect(res.json().error.code).toBe('UNDERAGE')
    const adult = await userWithToken(t, { birthDate: yearsAgo(18) })
    expect((await placeGet(t, adult.accessToken, vibe.id, { cashCents: 500 })).statusCode).toBe(201)
  })

  it('nenhum Get é gravado quando a elegibilidade falha', async () => {
    const { vibe } = await createLiveVibe(t)
    const u = await userWithToken(t, { verified: false })
    await placeGet(t, u.accessToken, vibe.id, { cashCents: 500 })
    expect(await t.db.select().from(gets).where(eq(gets.userId, u.id))).toHaveLength(0)
  })
})

describe('GetCoin', () => {
  it('débito na criação com lançamento SPEND_ON_GET referenciando o Get', async () => {
    const { vibe } = await createLiveVibe(t)
    const u = await userWithToken(t)
    await fund(t, u.id, 1000)
    const res = await placeGet(t, u.accessToken, vibe.id, { cashCents: 600, getcoinCents: 250 })
    const getId = res.json().data.get.id
    expect(await balanceOf(t, u.id)).toBe(750)
    const [l] = await t.db
      .select()
      .from(getcoinLedger)
      .where(and(eq(getcoinLedger.userId, u.id), eq(getcoinLedger.type, 'SPEND_ON_GET')))
    expect(l).toMatchObject({ amountCents: -250, balanceAfterCents: 750, referenceType: 'get', referenceId: getId })
  })

  it('gastar mais do que tem → 422 INSUFFICIENT_GETCOIN, saldo intacto, nenhum Get/pagamento criado', async () => {
    const { vibe } = await createLiveVibe(t)
    const u = await userWithToken(t)
    await fund(t, u.id, 100)
    const res = await placeGet(t, u.accessToken, vibe.id, { cashCents: 500, getcoinCents: 101 })
    expect(res.statusCode).toBe(422)
    expect(res.json().error.code).toBe('INSUFFICIENT_GETCOIN')
    expect(await balanceOf(t, u.id)).toBe(100)
    expect(await t.db.select().from(gets).where(eq(gets.userId, u.id))).toHaveLength(0)
    await assertLedgerInvariant(t)
  })

  it('sem saldo nenhum e getcoin > 0 → 422', async () => {
    const { vibe } = await createLiveVibe(t)
    const u = await userWithToken(t)
    expect((await placeGet(t, u.accessToken, vibe.id, { cashCents: 500, getcoinCents: 1 })).statusCode).toBe(422)
  })

  it('10 Gets simultâneos tentando gastar o mesmo saldo: só o que cabe passa e o saldo nunca fica negativo', async () => {
    const { vibe } = await createLiveVibe(t)
    const u = await userWithToken(t)
    await fund(t, u.id, 1000)
    const results = await Promise.all(
      Array.from({ length: 10 }, () => placeGet(t, u.accessToken, vibe.id, { cashCents: 400, getcoinCents: 400 })),
    )
    const codes = results.map((r) => r.statusCode).sort()
    expect(codes.filter((c) => c === 201)).toHaveLength(2)
    expect(codes.filter((c) => c === 422)).toHaveLength(8)
    expect(await balanceOf(t, u.id)).toBe(200)
    await assertLedgerInvariant(t)
  })
})

describe('Idempotency-Key', () => {
  it('sem chave → 400; chave inválida (curta / caracteres proibidos / > 128) → 400', async () => {
    const { vibe } = await createLiveVibe(t)
    const u = await userWithToken(t)
    const noKey = await t.app.inject({
      method: 'POST',
      url: `/api/v1/vibes/${vibe.id}/gets`,
      headers: bearer(u.accessToken),
      payload: { cashCents: 500, method: 'PIX' },
    })
    expect(noKey.statusCode).toBe(400)
    for (const k of ['curta', 'tem espaço aqui', "x'; drop table gets;--", 'a'.repeat(129)]) {
      expect((await placeGet(t, u.accessToken, vibe.id, { cashCents: 500 }, k)).statusCode, k).toBe(400)
    }
  })

  it('mesma chave + mesmo payload → 200 com o MESMO Get; GetCoin debitado uma vez só', async () => {
    const { vibe } = await createLiveVibe(t)
    const u = await userWithToken(t)
    await fund(t, u.id, 1000)
    const key = idemKey()
    const a = await placeGet(t, u.accessToken, vibe.id, { cashCents: 500, getcoinCents: 300 }, key)
    const b = await placeGet(t, u.accessToken, vibe.id, { cashCents: 500, getcoinCents: 300 }, key)
    expect(a.statusCode).toBe(201)
    expect(b.statusCode).toBe(200)
    expect(b.json().data.replayed).toBe(true)
    expect(b.json().data.get.id).toBe(a.json().data.get.id)
    expect(b.json().data.payment.id).toBe(a.json().data.payment.id)
    expect(await balanceOf(t, u.id)).toBe(700)
    expect(await t.db.select().from(gets).where(eq(gets.userId, u.id))).toHaveLength(1)
  })

  it.each([
    ['cash diferente', { cashCents: 501 }],
    ['getcoin diferente', { cashCents: 500, getcoinCents: 1 }],
    ['método diferente', { cashCents: 500, method: 'CARD' as const }],
  ])('mesma chave + %s → 409 IDEMPOTENCY_KEY_REUSED', async (_l, body) => {
    const { vibe } = await createLiveVibe(t)
    const u = await userWithToken(t)
    await fund(t, u.id, 10)
    const key = idemKey()
    expect((await placeGet(t, u.accessToken, vibe.id, { cashCents: 500 }, key)).statusCode).toBe(201)
    const res = await placeGet(t, u.accessToken, vibe.id, body, key)
    expect(res.statusCode).toBe(409)
    expect(res.json().error.code).toBe('IDEMPOTENCY_KEY_REUSED')
  })

  it('mesma chave em OUTRA Vibe → 409', async () => {
    const v1 = (await createLiveVibe(t)).vibe
    const v2 = (await createLiveVibe(t)).vibe
    const u = await userWithToken(t)
    const key = idemKey()
    await placeGet(t, u.accessToken, v1.id, { cashCents: 500 }, key)
    expect((await placeGet(t, u.accessToken, v2.id, { cashCents: 500 }, key)).statusCode).toBe(409)
  })

  it('5 requisições simultâneas com a mesma chave criam 1 Get e debitam GetCoin 1 vez', async () => {
    const { vibe } = await createLiveVibe(t)
    const u = await userWithToken(t)
    await fund(t, u.id, 1000)
    const key = idemKey()
    const rs = await Promise.all(Array.from({ length: 5 }, () => placeGet(t, u.accessToken, vibe.id, { cashCents: 500, getcoinCents: 200 }, key)))
    for (const r of rs) expect([200, 201], r.body).toContain(r.statusCode)
    expect(new Set(rs.map((r) => r.json().data.get.id)).size).toBe(1)
    expect(await t.db.select().from(gets).where(eq(gets.userId, u.id))).toHaveLength(1)
    expect(await balanceOf(t, u.id)).toBe(800)
  })

  it('replay de um Get que já falhou devolve o Get FAILED (não cria novo nem debita de novo)', async () => {
    const { vibe } = await createLiveVibe(t)
    const u = await userWithToken(t)
    await fund(t, u.id, 300)
    const key = idemKey()
    const a = await placeGet(t, u.accessToken, vibe.id, { cashCents: 500, getcoinCents: 300 }, key)
    const getId = a.json().data.get.id
    const payId = a.json().data.payment.id
    await t.app.inject({ method: 'POST', url: `/api/v1/payments/${payId}/simulate`, headers: bearer(u.accessToken), payload: { status: 'FAILED' } })
    expect(await balanceOf(t, u.id)).toBe(300)
    const b = await placeGet(t, u.accessToken, vibe.id, { cashCents: 500, getcoinCents: 300 }, key)
    expect(b.statusCode).toBe(200)
    expect(b.json().data.get).toMatchObject({ id: getId, status: 'FAILED' })
    expect(await balanceOf(t, u.id)).toBe(300)
    expect((await getRow(t, getId)).status).toBe('FAILED')
    const [p] = await t.db.select().from(payments).where(eq(payments.getId, getId))
    expect(p!.status).toBe('FAILED')
  })
})

describe('GET /me/gets', () => {
  it('lista os próprios Gets com Vibe, produto e pagamento; isChampion após o encerramento', async () => {
    const { vibe } = await createLiveVibe(t)
    const u = await userWithToken(t)
    const g = await placeGet(t, u.accessToken, vibe.id, { cashCents: 500 })
    const payId = g.json().data.payment.id
    await t.app.inject({ method: 'POST', url: `/api/v1/payments/${payId}/simulate`, headers: bearer(u.accessToken), payload: { status: 'PAID' } })
    await t.db.update(vibes).set({ winnerGetId: g.json().data.get.id }).where(eq(vibes.id, vibe.id))
    const res = await t.app.inject({ method: 'GET', url: '/api/v1/me/gets?pageSize=5', headers: bearer(u.accessToken) })
    expect(res.statusCode).toBe(200)
    expect(res.json().meta).toMatchObject({ page: 1, pageSize: 5, total: 1 })
    expect(res.json().data[0]).toMatchObject({ status: 'CONFIRMED', isChampion: true, payment: { status: 'PAID' } })
    expect(res.json().data[0].vibe.winnerGetId).toBeUndefined()
  })
})
