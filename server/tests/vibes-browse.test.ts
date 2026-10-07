/**
 * Página de Vibes: busca (q), ordenação (sort) e contagem por categoria (facets) em GET /vibes.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { products, vibes } from '../src/db/schema.js'
import { createTestApp, type TestContext } from './helpers.js'
import { get } from './qa-helpers.js'

let t: TestContext
const HOUR = 60 * 60 * 1000

async function vibe(name: string, category: 'smartphones' | 'notebooks' | 'audio', priceCents: number, o: { minGet?: number; endsInH?: number; status?: 'LIVE' | 'SCHEDULED' } = {}) {
  const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Math.floor(Math.random() * 1e6)}`
  const [p] = await t.db.insert(products).values({ slug, name, category, originalPriceCents: priceCents }).returning()
  await t.db.insert(vibes).values({
    productId: p!.id,
    slug: `vibe-${slug}`,
    status: o.status ?? 'LIVE',
    minGetCents: o.minGet ?? 395,
    startsAt: new Date(Date.now() - HOUR),
    endsAt: new Date(Date.now() + (o.endsInH ?? 24) * HOUR),
  })
}

beforeAll(async () => {
  t = await createTestApp()
  await vibe('iPhone 15 Pro Max', 'smartphones', 999_900, { endsInH: 5 })
  await vibe('Galaxy S24 Ultra', 'smartphones', 899_900, { endsInH: 30, minGet: 200 })
  await vibe('MacBook Pro M3', 'notebooks', 1_699_900, { endsInH: 10 })
  await vibe('Fone 100% sem fio', 'audio', 99_900, { endsInH: 50 })
  await vibe('iPhone 14', 'smartphones', 599_900, { status: 'SCHEDULED' })
})
afterAll(async () => {
  await t.close()
})

const names = (res: { json: () => { data: Array<{ product: { name: string } }> } }) => res.json().data.map((v) => v.product.name)

describe('GET /vibes — busca, ordenação e facets', () => {
  it('busca pelo nome do produto, sem diferenciar maiúsculas', async () => {
    const res = await get(t, '/vibes?status=LIVE&q=IPHONE')
    expect(res.statusCode).toBe(200)
    expect(names(res)).toEqual(['iPhone 15 Pro Max'])
  })

  it('curinga do LIKE digitado é tratado como texto (não lista tudo)', async () => {
    expect(names(await get(t, '/vibes?status=LIVE&q=100%25'))).toEqual(['Fone 100% sem fio'])
    expect(names(await get(t, '/vibes?status=LIVE&q=_'))).toEqual([])
  })

  it('facets contam por categoria com os mesmos filtros de status e busca, ignorando a categoria escolhida', async () => {
    const all = (await get(t, '/vibes?status=LIVE&category=audio')).json()
    expect(all.data).toHaveLength(1)
    expect(all.facets).toEqual({ smartphones: 2, notebooks: 1, audio: 1 })
    expect((await get(t, '/vibes?status=LIVE&q=iphone')).json().facets).toEqual({ smartphones: 1 })
  })

  it('ordena por prazo (padrão), preço e Get mínimo', async () => {
    expect(names(await get(t, '/vibes?status=LIVE'))).toEqual(['iPhone 15 Pro Max', 'MacBook Pro M3', 'Galaxy S24 Ultra', 'Fone 100% sem fio'])
    expect(names(await get(t, '/vibes?status=LIVE&sort=price-high'))[0]).toBe('MacBook Pro M3')
    expect(names(await get(t, '/vibes?status=LIVE&sort=price-low'))[0]).toBe('Fone 100% sem fio')
    expect(names(await get(t, '/vibes?status=LIVE&sort=min-get'))[0]).toBe('Galaxy S24 Ultra')
  })

  it('recusa ordenação desconhecida e busca longa demais', async () => {
    expect((await get(t, '/vibes?sort=aleatorio')).statusCode).toBe(400)
    expect((await get(t, `/vibes?q=${'a'.repeat(81)}`)).statusCode).toBe(400)
  })
})
