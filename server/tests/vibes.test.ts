/**
 * QA — rotas públicas de Vibes e exibição do maior Get sem dados pessoais.
 */
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { vibes } from '../src/db/schema.js'
import { publicName } from '../src/lib/presenters.js'
import { createLiveVibe, createTestApp, userWithToken, type TestContext } from './helpers.js'
import { confirmedGet, get, placeGet } from './qa-helpers.js'

let t: TestContext
beforeAll(async () => {
  t = await createTestApp()
})
afterAll(async () => {
  await t.close()
})

describe('publicName', () => {
  it.each([
    ['Pedro Agostini', 'Pedro A.'],
    ['Maria da Silva Souza', 'Maria S.'],
    ['  ana   lima  ', 'ana L.'],
    ['Cher', 'Cher'],
    ['', 'Anônimo'],
  ])('%s → %s', (input, out) => expect(publicName(input)).toBe(out))
})

describe('GET /vibes e /vibes/:slug', () => {
  it('lista só SCHEDULED/LIVE/ENDED (DRAFT e CANCELLED ficam de fora), com paginação', async () => {
    const draft = (await createLiveVibe(t, { status: 'DRAFT' })).vibe
    const live = (await createLiveVibe(t)).vibe
    const canc = (await createLiveVibe(t)).vibe
    await t.db.update(vibes).set({ status: 'CANCELLED' }).where(eq(vibes.id, canc.id))
    const res = await get(t, '/vibes?pageSize=100')
    expect(res.statusCode).toBe(200)
    const slugs = res.json().data.map((v: { slug: string }) => v.slug)
    expect(slugs).toContain(live.slug)
    expect(slugs).not.toContain(draft.slug)
    expect(slugs).not.toContain(canc.slug)
    expect((await get(t, `/vibes/${draft.slug}`)).statusCode).toBe(404)
    expect((await get(t, `/vibes/${canc.slug}`)).statusCode).toBe(404)
    expect((await get(t, '/vibes?status=DRAFT')).statusCode).toBe(400)
    expect((await get(t, '/vibes?status=CANCELLED')).statusCode).toBe(400)
  })

  it('maior Get público: só confirmados, primeiro nome + inicial, sem userId/e-mail/CPF', async () => {
    const { vibe } = await createLiveVibe(t)
    const big = await userWithToken(t, { name: 'Roberto Carlos Nogueira' })
    const small = await userWithToken(t, { name: 'Zeca Pagodinho' })
    const pend = await userWithToken(t, { name: 'Pendente Maior' })
    await confirmedGet(t, big.accessToken, vibe.id, { cashCents: 3000 })
    await confirmedGet(t, small.accessToken, vibe.id, { cashCents: 1000 })
    await placeGet(t, pend.accessToken, vibe.id, { cashCents: 9000 })

    const one = await get(t, `/vibes/${vibe.slug}`)
    expect(one.statusCode).toBe(200)
    const d = one.json().data
    expect(d.confirmedGets).toBe(2)
    expect(d.topGet).toMatchObject({ totalCents: 3000, by: 'Roberto N.' })
    const raw = one.body
    for (const leak of [big.id, big.email, small.id, 'Nogueira', 'Carlos', 'Pendente', 'cpf', 'userId']) {
      expect(raw, leak).not.toContain(leak)
    }
    const list = await get(t, '/vibes?pageSize=100')
    const item = list.json().data.find((v: { id: string }) => v.id === vibe.id)
    expect(item.topGet.by).toBe('Roberto N.')
    expect(list.body).not.toContain(big.email)
  })

  it('filtros e validação: categoria válida filtra; inválida → 400; slug malicioso → 400/404', async () => {
    await createLiveVibe(t)
    const res = await get(t, '/vibes?category=smartphones')
    expect(res.statusCode).toBe(200)
    expect(res.json().data.every((v: { product: { category: string } }) => v.product.category === 'smartphones')).toBe(true)
    expect((await get(t, '/vibes?category=armas')).statusCode).toBe(400)
    expect((await get(t, "/vibes/x'%20or%201=1--")).statusCode).toBe(400)
    expect((await get(t, '/vibes/nao-existe')).statusCode).toBe(404)
  })

  it('/health é público', async () => {
    expect((await get(t, '/health')).statusCode).toBe(200)
  })
})
