/**
 * D10 — página da Vibe: detalhe (galeria, ficha técnica, benefícios, últimos Gets), visitante único por dia,
 * favoritos e consulta do próprio Get.
 */
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { products, vibes } from '../src/db/schema.js'
import { CSRF, createLiveVibe, createTestApp, userWithToken, type TestContext } from './helpers.js'
import { authed, confirmedGet, get, send } from './qa-helpers.js'

let t: TestContext
beforeAll(async () => {
  t = await createTestApp()
})
afterAll(async () => {
  await t.close()
})

describe('GET /vibes/:slug — dados da página', () => {
  it('traz marca, modelo, galeria (com a capa como reserva), ficha técnica, benefícios e contadores', async () => {
    const { product, vibe } = await createLiveVibe(t)
    await t.db.update(products).set({ imageUrl: '/img/capa.jpg', brand: 'Apple', model: 'A3106', specs: [{ label: 'Armazenamento', value: '256 GB' }] }).where(eq(products.id, product.id))
    await t.db.update(vibes).set({ benefits: ['Película de brinde'] }).where(eq(vibes.id, vibe.id))

    const d = (await get(t, `/vibes/${vibe.slug}`)).json().data
    expect(d.product).toMatchObject({ brand: 'Apple', model: 'A3106', images: ['/img/capa.jpg'], specs: [{ label: 'Armazenamento', value: '256 GB' }] })
    expect(d).toMatchObject({ benefits: ['Película de brinde'], viewsCount: 0, favoritesCount: 0, recentGets: [] })

    await t.db.update(products).set({ images: ['/img/a.jpg', '/img/b.jpg'] }).where(eq(products.id, product.id))
    expect((await get(t, `/vibes/${vibe.slug}`)).json().data.product.images).toEqual(['/img/a.jpg', '/img/b.jpg'])
  })

  it('últimos Gets mostram só valor, horário e nome público', async () => {
    const { vibe } = await createLiveVibe(t)
    const u = await userWithToken(t)
    await confirmedGet(t, u.accessToken, vibe.id, { cashCents: 1000 })
    const [g] = (await get(t, `/vibes/${vibe.slug}`)).json().data.recentGets
    expect(Object.keys(g).sort()).toEqual(['at', 'by', 'totalCents'])
    expect(g.totalCents).toBe(1000)
  })
})

describe('POST /vibes/:slug/view — visitante único por dia', () => {
  it('conta uma vez por cookie por dia; outro visitante soma de novo; sem CSRF é recusado', async () => {
    const { vibe } = await createLiveVibe(t)
    const first = await send(t, 'POST', `/vibes/${vibe.slug}/view`, undefined, CSRF)
    expect(first.statusCode).toBe(200)
    expect(first.json().data.viewsCount).toBe(1)
    const cookie = first.cookies.find((c) => c.name === 'vg_vid')
    expect(cookie).toMatchObject({ httpOnly: true, path: '/api/v1/vibes' })

    const again = await send(t, 'POST', `/vibes/${vibe.slug}/view`, undefined, { ...CSRF, cookie: `vg_vid=${cookie!.value}` })
    expect(again.json().data.viewsCount).toBe(1)
    const other = await send(t, 'POST', `/vibes/${vibe.slug}/view`, undefined, CSRF)
    expect(other.json().data.viewsCount).toBe(2)

    expect((await send(t, 'POST', `/vibes/${vibe.slug}/view`)).statusCode).toBe(403)
    expect((await send(t, 'POST', '/vibes/nao-existe/view', undefined, CSRF)).statusCode).toBe(404)
  })
})

describe('favoritos e GET /me/gets/:id', () => {
  it('favoritar, listar, contar e desfavoritar (idempotente)', async () => {
    const { vibe } = await createLiveVibe(t)
    const u = await userWithToken(t)
    expect((await send(t, 'PUT', `/me/favorites/${vibe.id}`, undefined, authed(u.accessToken))).statusCode).toBe(204)
    expect((await send(t, 'PUT', `/me/favorites/${vibe.id}`, undefined, authed(u.accessToken))).statusCode).toBe(204)
    expect((await get(t, '/me/favorites', u.accessToken)).json().data).toEqual([vibe.id])
    expect((await get(t, `/vibes/${vibe.slug}`)).json().data.favoritesCount).toBe(1)
    expect((await send(t, 'DELETE', `/me/favorites/${vibe.id}`, undefined, authed(u.accessToken))).statusCode).toBe(204)
    expect((await get(t, '/me/favorites', u.accessToken)).json().data).toEqual([])
    expect((await send(t, 'PUT', '/me/favorites/00000000-0000-4000-8000-000000000000', undefined, authed(u.accessToken))).statusCode).toBe(404)
    expect((await get(t, '/me/favorites')).statusCode).toBe(401)
  })

  it('o dono consulta o próprio Get com o pagamento; outro usuário recebe 404', async () => {
    const { vibe } = await createLiveVibe(t)
    const a = await userWithToken(t)
    const b = await userWithToken(t)
    const getId = await confirmedGet(t, a.accessToken, vibe.id, { cashCents: 800 })
    const mine = await get(t, `/me/gets/${getId}`, a.accessToken)
    expect(mine.statusCode).toBe(200)
    expect(mine.json().data.get).toMatchObject({ id: getId, status: 'CONFIRMED' })
    expect(mine.json().data.payment).toBeTruthy()
    expect((await get(t, `/me/gets/${getId}`, b.accessToken)).statusCode).toBe(404)
  })
})
