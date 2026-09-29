/**
 * QA — /admin: produtos, Vibes (criação, transições), dashboard, busca de usuários, Gets e audit log.
 */
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { vibes } from '../src/db/schema.js'
import { bearer, createLiveVibe, createTestApp, createUser, getUserRow, userWithToken, type TestContext } from './helpers.js'
import { confirmedGet, fund, get, placeGet, send } from './qa-helpers.js'

let t: TestContext
let admin: Awaited<ReturnType<typeof userWithToken>>
let support: Awaited<ReturnType<typeof userWithToken>>
beforeAll(async () => {
  t = await createTestApp()
  admin = await userWithToken(t, { role: 'ADMIN' })
  support = await userWithToken(t, { role: 'SUPPORT' })
})
afterAll(async () => {
  await t.close()
})

const A = () => bearer(admin.accessToken)
let n = 0
const slug = (p = 'qa') => `${p}-${Date.now()}-${++n}`
const hours = (h: number) => new Date(Date.now() + h * 3600_000).toISOString()

async function newProduct() {
  const res = await send(t, 'POST', '/admin/products', { slug: slug('prod'), name: 'Fone QA', category: 'audio', originalPriceCents: 29_900 }, A())
  expect(res.statusCode, res.body).toBe(201)
  return res.json().data as { id: string; slug: string }
}

describe('produtos', () => {
  it('cria, lista (busca literal), edita e audita', async () => {
    const p = await newProduct()
    const list = await get(t, '/admin/products?q=Fone', admin.accessToken)
    expect(list.json().data.some((x: { id: string }) => x.id === p.id)).toBe(true)
    const wild = await get(t, '/admin/products?q=%25', admin.accessToken)
    expect(wild.json().data).toEqual([])
    const patch = await send(t, 'PATCH', `/admin/products/${p.id}`, { name: 'Fone QA 2', imageUrl: 'https://cdn.exemplo.com/a.jpg' }, A())
    expect(patch.statusCode).toBe(200)
    expect(patch.json().data.name).toBe('Fone QA 2')
    const logs = await get(t, `/admin/audit-logs?entityId=${p.id}`, admin.accessToken)
    expect(logs.json().data.map((l: { action: string }) => l.action).sort()).toEqual(['PRODUCT_CREATED', 'PRODUCT_UPDATED'])
  })

  it('slug duplicado → 409 SLUG_TAKEN', async () => {
    const p = await newProduct()
    const res = await send(t, 'POST', '/admin/products', { slug: p.slug, name: 'Outro', category: 'audio', originalPriceCents: 100 }, A())
    expect(res.statusCode).toBe(409)
    expect(res.json().error.code).toBe('SLUG_TAKEN')
  })

  it.each([
    ['imageUrl javascript:', { imageUrl: 'javascript:alert(1)' }],
    ['imageUrl http (não https)', { imageUrl: 'http://x.com/a.png' }],
    ['imageUrl data:', { imageUrl: 'data:image/png;base64,AAA' }],
    // [QA-13] "//host/..." passa na regex de caminho relativo e vira imagem de host arbitrário
    ['[QA-13] imageUrl protocol-relative', { imageUrl: '//evil.com/a.png' }],
    ['categoria inválida', { category: 'armas' }],
    ['preço zero', { originalPriceCents: 0 }],
    ['slug com maiúsculas', { slug: 'Slug-Ruim' }],
    ['campo extra', { id: '00000000-0000-4000-8000-000000000000' }],
  ])('rejeita %s (400)', async (_l, override) => {
    const res = await send(t, 'POST', '/admin/products', { slug: slug(), name: 'X Produto', category: 'audio', originalPriceCents: 100, ...override }, A())
    expect(res.statusCode, res.body).toBe(400)
  })

  it('PATCH vazio → 400; inexistente → 404', async () => {
    const p = await newProduct()
    expect((await send(t, 'PATCH', `/admin/products/${p.id}`, {}, A())).statusCode).toBe(400)
    expect((await send(t, 'PATCH', `/admin/products/00000000-0000-4000-8000-000000000000`, { name: 'Novo nome' }, A())).statusCode).toBe(404)
  })
})

describe('Vibes (admin)', () => {
  it('cria DRAFT por padrão com cashback 40; produto inexistente → 404; slug duplicado → 409', async () => {
    const p = await newProduct()
    const s = slug('vibe')
    const res = await send(t, 'POST', '/admin/vibes', { productId: p.id, slug: s, minGetCents: 395, startsAt: hours(1), endsAt: hours(48) }, A())
    expect(res.statusCode, res.body).toBe(201)
    expect(res.json().data).toMatchObject({ status: 'DRAFT', cashbackPercent: 40, winnerGetId: null })
    expect(
      (await send(t, 'POST', '/admin/vibes', { productId: '00000000-0000-4000-8000-000000000000', slug: slug(), minGetCents: 395, startsAt: hours(1), endsAt: hours(2) }, A()))
        .statusCode,
    ).toBe(404)
    expect((await send(t, 'POST', '/admin/vibes', { productId: p.id, slug: s, minGetCents: 395, startsAt: hours(1), endsAt: hours(2) }, A())).statusCode).toBe(409)
  })

  it.each([
    ['endsAt antes de startsAt', { startsAt: hours(5), endsAt: hours(1) }],
    ['mais de 15 dias', { startsAt: hours(1), endsAt: hours(1 + 15 * 24 + 1) }],
    ['status ENDED na criação', { status: 'ENDED' }],
    ['winnerGetId na criação', { winnerGetId: '00000000-0000-4000-8000-000000000000' }],
    ['settledAt na criação', { settledAt: hours(0) }],
    ['cashback 101', { cashbackPercent: 101 }],
    ['min 0', { minGetCents: 0 }],
  ])('rejeita %s (400)', async (_l, o) => {
    const p = await newProduct()
    const res = await send(t, 'POST', '/admin/vibes', { productId: p.id, slug: slug(), minGetCents: 395, startsAt: hours(1), endsAt: hours(2), ...o }, A())
    expect(res.statusCode, res.body).toBe(400)
  })

  it('transições: DRAFT→SCHEDULED→LIVE ok; LIVE→DRAFT/SCHEDULED 409; ENDED via PATCH → 400', async () => {
    const { vibe } = await createLiveVibe(t, { status: 'DRAFT' })
    expect((await send(t, 'PATCH', `/admin/vibes/${vibe.id}`, { status: 'SCHEDULED' }, A())).statusCode).toBe(200)
    expect((await send(t, 'PATCH', `/admin/vibes/${vibe.id}`, { status: 'LIVE' }, A())).statusCode).toBe(200)
    const back = await send(t, 'PATCH', `/admin/vibes/${vibe.id}`, { status: 'DRAFT' }, A())
    expect(back.statusCode).toBe(409)
    expect(back.json().error.code).toBe('INVALID_TRANSITION')
    expect((await send(t, 'PATCH', `/admin/vibes/${vibe.id}`, { status: 'SCHEDULED' }, A())).statusCode).toBe(409)
    expect((await send(t, 'PATCH', `/admin/vibes/${vibe.id}`, { status: 'ENDED' }, A())).statusCode).toBe(400)
  })

  it('LIVE: valores monetários congelados (min, cashback, startsAt, slug → 409 VIBE_LOCKED); endsAt/goalGets podem mudar', async () => {
    const { vibe } = await createLiveVibe(t)
    for (const body of [{ minGetCents: 1 }, { cashbackPercent: 100 }, { startsAt: hours(-5) }, { slug: slug() }]) {
      const res = await send(t, 'PATCH', `/admin/vibes/${vibe.id}`, body, A())
      expect(res.statusCode, JSON.stringify(body)).toBe(409)
      expect(res.json().error.code).toBe('VIBE_LOCKED')
    }
    expect((await send(t, 'PATCH', `/admin/vibes/${vibe.id}`, { goalGets: 99 }, A())).statusCode).toBe(200)
    expect((await send(t, 'PATCH', `/admin/vibes/${vibe.id}`, { endsAt: hours(30) }, A())).statusCode).toBe(200)
    const past = await send(t, 'PATCH', `/admin/vibes/${vibe.id}`, { endsAt: hours(-1) }, A())
    expect(past.statusCode).toBe(400)
  })

  /**
   * [QA-11] Vibe LIVE cujo prazo JÁ venceu (job ainda não rodou) pode ter o endsAt estendido e voltar a aceitar
   * Gets. Esperado: depois do vencimento a disputa não reabre (só /close).
   */
  it('[QA-11] não deve reabrir uma Vibe LIVE já vencida estendendo endsAt', async () => {
    const { vibe } = await createLiveVibe(t)
    await t.db
      .update(vibes)
      .set({ startsAt: new Date(Date.now() - 48 * 3600_000), endsAt: new Date(Date.now() - 60_000) })
      .where(eq(vibes.id, vibe.id))
    const res = await send(t, 'PATCH', `/admin/vibes/${vibe.id}`, { endsAt: hours(24) }, A())
    expect(res.statusCode).toBe(409)
  })

  it('ENDED é imutável', async () => {
    const { vibe } = await createLiveVibe(t)
    await send(t, 'POST', `/admin/vibes/${vibe.id}/close`, undefined, A())
    expect((await send(t, 'PATCH', `/admin/vibes/${vibe.id}`, { goalGets: 1 }, A())).statusCode).toBe(409)
    expect((await send(t, 'PATCH', `/admin/vibes/${vibe.id}`, { status: 'CANCELLED' }, A())).statusCode).toBe(409)
  })

  it('SCHEDULED/DRAFT: pode editar datas mas respeita 15 dias e endsAt > startsAt', async () => {
    const { vibe } = await createLiveVibe(t, { status: 'SCHEDULED' })
    expect((await send(t, 'PATCH', `/admin/vibes/${vibe.id}`, { endsAt: hours(-2) }, A())).statusCode).toBe(400)
    expect((await send(t, 'PATCH', `/admin/vibes/${vibe.id}`, { endsAt: hours(24 * 20) }, A())).statusCode).toBe(400)
    expect((await send(t, 'PATCH', `/admin/vibes/${vibe.id}`, { minGetCents: 500, cashbackPercent: 30 }, A())).statusCode).toBe(200)
  })

  it('GET /admin/vibes inclui DRAFT/CANCELLED e filtra por status', async () => {
    const { vibe } = await createLiveVibe(t, { status: 'DRAFT' })
    const res = await get(t, '/admin/vibes?status=DRAFT&pageSize=100', support.accessToken)
    expect(res.json().data.some((v: { id: string }) => v.id === vibe.id)).toBe(true)
  })
})

describe('usuários (admin)', () => {
  it('busca por nome/e-mail escapa curingas; busca por CPF exato', async () => {
    const u = await createUser(t, { name: 'Gustavo Buscavel' })
    const cpf = (await getUserRow(t, u.id)).cpf!
    const byName = await get(t, '/admin/users?q=Buscavel', support.accessToken)
    expect(byName.json().data.map((x: { id: string }) => x.id)).toContain(u.id)
    const byCpf = await get(t, `/admin/users?q=${cpf}`, support.accessToken)
    expect(byCpf.json().data.map((x: { id: string }) => x.id)).toEqual([u.id])
    const wildcard = await get(t, '/admin/users?q=%25', support.accessToken)
    expect(wildcard.json().data).toEqual([])
    const underscore = await get(t, '/admin/users?q=_', support.accessToken)
    expect(underscore.json().data).toEqual([])
    expect((await get(t, '/admin/users?role=GOD', support.accessToken)).statusCode).toBe(400)
    expect((await get(t, '/admin/users?q=', support.accessToken)).statusCode).toBe(400)
  })

  it('resposta admin não traz hash de senha', async () => {
    const res = await get(t, '/admin/users?pageSize=100', support.accessToken)
    expect(res.body).not.toMatch(/passwordHash|argon2/)
  })
})

describe('dashboard, Gets e audit', () => {
  it('dashboard admin agrega usuários, Vibes, receita confirmada, GetCoin emitido x gasto e Gets 24h', async () => {
    const ctx = await createTestApp()
    try {
      const adm = await userWithToken(ctx, { role: 'ADMIN' })
      const u = await userWithToken(ctx)
      const { vibe } = await createLiveVibe(ctx)
      await fund(ctx, u.id, 1000)
      await confirmedGet(ctx, u.accessToken, vibe.id, { cashCents: 700, getcoinCents: 300 })
      await placeGet(ctx, u.accessToken, vibe.id, { cashCents: 500 })
      const res = await get(ctx, '/admin/dashboard', adm.accessToken)
      expect(res.statusCode).toBe(200)
      const d = res.json().data
      expect(d.users).toMatchObject({ total: 2, new7d: 2, byLevel: { EXPLORADOR: 2 }, byRole: { ADMIN: 1, USER: 1 } })
      expect(d.vibes.byStatus).toMatchObject({ LIVE: 1 })
      expect(d.revenue.confirmedCents).toBe(700)
      expect(d.getcoin).toMatchObject({ issuedCents: 1000, spentCents: 300, byType: { ADJUSTMENT: 1000, SPEND_ON_GET: -300 } })
      expect(d.gets.last24h).toBe(2)
    } finally {
      await ctx.close()
    }
  })

  it('GET /admin/gets filtra por usuário/status e mostra pagamento', async () => {
    const { vibe } = await createLiveVibe(t)
    const u = await userWithToken(t)
    await confirmedGet(t, u.accessToken, vibe.id, { cashCents: 600 })
    const res = await get(t, `/admin/gets?userId=${u.id}&status=CONFIRMED`, support.accessToken)
    expect(res.statusCode).toBe(200)
    expect(res.json().data).toHaveLength(1)
    expect(res.json().data[0]).toMatchObject({ userId: u.id, payment: { status: 'PAID' } })
  })

  it('audit-logs: filtros e datas inválidas → 400', async () => {
    const res = await get(t, `/admin/audit-logs?actorId=${admin.id}&pageSize=5`, support.accessToken)
    expect(res.statusCode).toBe(200)
    expect(res.json().data.every((l: { actorId: string }) => l.actorId === admin.id)).toBe(true)
    expect((await get(t, '/admin/audit-logs?from=ontem', support.accessToken)).statusCode).toBe(400)
    expect((await get(t, '/admin/audit-logs?actorId=abc', support.accessToken)).statusCode).toBe(400)
  })
})
