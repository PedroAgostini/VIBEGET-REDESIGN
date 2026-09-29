/**
 * QA — D1: corte de Gets no minuto final e prazo de pagamento gravado em expires_at.
 */
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { payments, vibes } from '../src/db/schema.js'
import { runScheduledJobs } from '../src/jobs/index.js'
import { vibeDeadlines } from '../src/modules/vibes/deadlines.js'
import { bearer, createLiveVibe, createTestApp, userWithToken, type TestContext } from './helpers.js'
import {
  assertLedgerInvariant,
  balanceOf,
  externalIdOfGet,
  fund,
  get,
  getRow,
  paymentOfGet,
  placeGet,
  send,
  webhook,
} from './qa-helpers.js'

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

async function vibeEndingIn(ms: number) {
  const { vibe } = await createLiveVibe(t)
  const endsAt = new Date(Date.now() + ms)
  await t.db.update(vibes).set({ endsAt }).where(eq(vibes.id, vibe.id))
  return { ...vibe, endsAt }
}
const setSettings = (body: object) => send(t, 'PATCH', '/admin/settings', body, bearer(admin.accessToken))

describe('vibeDeadlines (unidade)', () => {
  it('cutoff e prazo de pagamento; prazo nunca passa do fim; corte 0', () => {
    const end = new Date('2026-10-01T12:00:00Z')
    const d = vibeDeadlines(end, { getCutoffSeconds: 60, paymentGraceSeconds: 40 })
    expect(d.cutoffAt.toISOString()).toBe('2026-10-01T11:59:00.000Z')
    expect(d.paymentDeadline.toISOString()).toBe('2026-10-01T11:59:40.000Z')
    const z = vibeDeadlines(end, { getCutoffSeconds: 0, paymentGraceSeconds: 0 })
    expect(z.cutoffAt.getTime()).toBe(end.getTime())
    expect(z.paymentDeadline.getTime()).toBe(end.getTime())
    expect(vibeDeadlines(end, { getCutoffSeconds: 10, paymentGraceSeconds: 999 }).paymentDeadline.getTime()).toBe(end.getTime())
  })
})

describe('corte de Gets', () => {
  it('61 s do fim → 201; 60 s → 409 VIBE_CLOSING; 59 s → 409', async () => {
    const u = await userWithToken(t)
    const a = await vibeEndingIn(61_500)
    expect((await placeGet(t, u.accessToken, a.id, { cashCents: 500 })).statusCode).toBe(201)
    for (const ms of [60_000, 59_000]) {
      const v = await vibeEndingIn(ms)
      const r = await placeGet(t, u.accessToken, v.id, { cashCents: 500 })
      expect(r.statusCode, String(ms)).toBe(409)
      expect(r.json().error.code).toBe('VIBE_CLOSING')
    }
  })

  it('Get recusado no corte não debita GetCoin nem cria registro', async () => {
    const u = await userWithToken(t)
    await fund(t, u.id, 300)
    const v = await vibeEndingIn(30_000)
    expect((await placeGet(t, u.accessToken, v.id, { cashCents: 500, getcoinCents: 300 })).statusCode).toBe(409)
    expect(await balanceOf(t, u.id)).toBe(300)
  })

  it('getsCloseAt público = endsAt - corte (lista e detalhe), e acompanha a configuração', async () => {
    const v = await vibeEndingIn(3 * 3600_000)
    const one = (await get(t, `/vibes/${v.slug}`)).json().data
    expect(new Date(one.endsAt).getTime() - new Date(one.getsCloseAt).getTime()).toBe(60_000)
    const list = (await get(t, '/vibes?pageSize=100')).json().data.find((x: { id: string }) => x.id === v.id)
    expect(list.getsCloseAt).toBe(one.getsCloseAt)
    expect((await setSettings({ getCutoffSeconds: 120 })).statusCode).toBe(200)
    const after = (await get(t, `/vibes/${v.slug}`)).json().data
    expect(new Date(after.endsAt).getTime() - new Date(after.getsCloseAt).getTime()).toBe(120_000)
    await setSettings({ getCutoffSeconds: 60 })
  })

  it('corte 0 (configurado): Get aceito até o fim; expires_at = endsAt', async () => {
    expect((await setSettings({ getCutoffSeconds: 0, paymentGraceSeconds: 0 })).statusCode).toBe(200)
    try {
      const u = await userWithToken(t)
      const v = await vibeEndingIn(5_000)
      const r = await placeGet(t, u.accessToken, v.id, { cashCents: 500 })
      expect(r.statusCode, r.body).toBe(201)
      expect(new Date(r.json().data.payment.expiresAt).getTime()).toBe(v.endsAt.getTime())
    } finally {
      await setSettings({ getCutoffSeconds: 60, paymentGraceSeconds: 40 })
    }
  })
})

describe('prazo de pagamento', () => {
  it('longe do fim: expires_at = agora + TTL; perto do fim: expires_at = endsAt - 20 s', async () => {
    const u = await userWithToken(t)
    const far = await vibeEndingIn(5 * 3600_000)
    const t0 = Date.now()
    const a = await placeGet(t, u.accessToken, far.id, { cashCents: 500 })
    const expA = new Date(a.json().data.payment.expiresAt).getTime()
    expect(expA - t0).toBeGreaterThan(29 * 60_000)
    expect(expA - t0).toBeLessThanOrEqual(30 * 60_000 + 2000)
    const near = await vibeEndingIn(5 * 60_000)
    const b = await placeGet(t, u.accessToken, near.id, { cashCents: 500 })
    expect(new Date(b.json().data.payment.expiresAt).getTime()).toBe(near.endsAt.getTime() - 20_000)
  })

  it('PAID antes do prazo conta; PAID depois do prazo é estornado (com o job rodando ou não), GetCoin devolvido uma vez', async () => {
    const u = await userWithToken(t)
    await fund(t, u.id, 200)
    const v = await vibeEndingIn(5 * 60_000)
    const ok = await placeGet(t, u.accessToken, v.id, { cashCents: 500 })
    expect((await webhook(t, await externalIdOfGet(t, ok.json().data.get.id), 'PAID')).json().changed).toBe(true)
    expect((await getRow(t, ok.json().data.get.id)).status).toBe('CONFIRMED')

    // dois Gets atrasados: um com job antes do PAID, outro sem job
    const late1 = await placeGet(t, u.accessToken, v.id, { cashCents: 500, getcoinCents: 100 })
    const late2 = await placeGet(t, u.accessToken, v.id, { cashCents: 500, getcoinCents: 100 })
    const past = new Date(Date.now() - 1000)
    for (const g of [late1, late2]) {
      await t.db.update(payments).set({ expiresAt: past }).where(eq(payments.id, g.json().data.payment.id))
    }
    // sem job
    const r2 = await webhook(t, await externalIdOfGet(t, late2.json().data.get.id), 'PAID')
    expect(r2.json().changed).toBe(true)
    // com job (expira) e PAID depois
    await runScheduledJobs({ db: t.db, log: t.app.log })
    const r1 = await webhook(t, await externalIdOfGet(t, late1.json().data.get.id), 'PAID')
    expect(r1.json().changed).toBe(true)
    for (const g of [late1, late2]) {
      const id = g.json().data.get.id
      expect((await getRow(t, id)).status).toBe('REFUNDED')
      expect((await paymentOfGet(t, id)).status).toBe('REFUNDED')
    }
    // replay não estorna de novo
    await webhook(t, await externalIdOfGet(t, late2.json().data.get.id), 'PAID')
    expect(await balanceOf(t, u.id)).toBe(200)
    await assertLedgerInvariant(t)
  })

  it('mudar as configurações depois não altera expires_at de Gets já criados', async () => {
    const u = await userWithToken(t)
    const v = await vibeEndingIn(5 * 60_000)
    const g = await placeGet(t, u.accessToken, v.id, { cashCents: 500 })
    const before = (await paymentOfGet(t, g.json().data.get.id)).expiresAt.getTime()
    await setSettings({ getCutoffSeconds: 600, paymentGraceSeconds: 10 })
    try {
      expect((await paymentOfGet(t, g.json().data.get.id)).expiresAt.getTime()).toBe(before)
      // e o PAID dentro do prazo antigo continua valendo
      expect((await webhook(t, await externalIdOfGet(t, g.json().data.get.id), 'PAID')).json().changed).toBe(true)
      expect((await getRow(t, g.json().data.get.id)).status).toBe('CONFIRMED')
      // Get novo já usa o corte novo (10 min)
      expect((await placeGet(t, u.accessToken, v.id, { cashCents: 500 })).json().error.code).toBe('VIBE_CLOSING')
    } finally {
      await setSettings({ getCutoffSeconds: 60, paymentGraceSeconds: 40 })
    }
  })

  /**
   * [QA-17] O prazo do pagamento é fixado na criação do Get. Se o ADMIN ENCURTA o endsAt de uma Vibe LIVE,
   * pagamentos já criados mantêm o expires_at antigo (até 30 min). Depois do novo fim, enquanto o job não
   * encerrou a Vibe, um PAID ainda conta — o resultado volta a depender do momento do job (o que D1 resolveu).
   * Esperado: PAID depois do prazo de pagamento da Vibe (endsAt - corte + margem ATUAIS) é estornado.
   */
  it('[QA-17] encurtar endsAt não pode deixar PAID contar depois do novo prazo', async () => {
    const u = await userWithToken(t)
    const v = await vibeEndingIn(5 * 3600_000)
    const g = await placeGet(t, u.accessToken, v.id, { cashCents: 500 })
    const patch = await send(t, 'PATCH', `/admin/vibes/${v.id}`, { endsAt: new Date(Date.now() + 120_000).toISOString() }, bearer(admin.accessToken))
    expect(patch.statusCode, patch.body).toBe(200)
    // o tempo passa: novo fim já passou, job ainda não rodou
    await t.db.update(vibes).set({ endsAt: new Date(Date.now() - 1000) }).where(eq(vibes.id, v.id))
    await webhook(t, await externalIdOfGet(t, g.json().data.get.id), 'PAID')
    expect((await getRow(t, g.json().data.get.id)).status).toBe('REFUNDED')
  })
})
