/**
 * Sanidade do builder para as decisões do cliente D1–D5 (seção 6.1). A suíte completa é do QA.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadEnv } from '../src/config/env.js'
import { payments, vibes } from '../src/db/schema.js'
import { seed } from '../src/db/seed.js'
import { bearer, createLiveVibe, createTestApp, CSRF, nextCpf, userWithToken, type TestContext } from './helpers.js'
import { PROD_ENV } from './qa-helpers.js'

let t: TestContext
let admin: Awaited<ReturnType<typeof userWithToken>>
const uploadDir = mkdtempSync(path.join(os.tmpdir(), 'vg-uploads-'))

beforeAll(async () => {
  t = await createTestApp({ env: { UPLOAD_DIR: uploadDir, UPLOAD_MAX_BYTES: '200000' } })
  admin = await userWithToken(t, { role: 'ADMIN' })
})
afterAll(async () => {
  await t.close()
  rmSync(uploadDir, { recursive: true, force: true })
})

const api = (method: 'GET' | 'POST' | 'PATCH', url: string, token?: string, payload?: object) =>
  t.app.inject({ method, url: `/api/v1${url}`, headers: token ? bearer(token) : {}, ...(payload ? { payload } : {}) })

async function vibeEndingIn(ms: number) {
  const { vibe } = await createLiveVibe(t)
  await t.db.update(vibes).set({ endsAt: new Date(Date.now() + ms) }).where(eq(vibes.id, vibe.id))
  return { ...vibe, endsAt: new Date(Date.now() + ms) }
}

const placeGet = (token: string, vibeId: string, key: string, cashCents = 500) =>
  t.app.inject({
    method: 'POST',
    url: `/api/v1/vibes/${vibeId}/gets`,
    headers: { ...bearer(token), 'idempotency-key': key },
    payload: { cashCents, method: 'PIX' },
  })

describe('D1 — corte do minuto final e prazo de pagamento', () => {
  it('Get no último minuto → 409 VIBE_CLOSING; getsCloseAt público = endsAt - 60 s', async () => {
    const v = await vibeEndingIn(30_000)
    const u = await userWithToken(t)
    const res = await placeGet(u.accessToken, v.id, 'd1-closing-1')
    expect(res.statusCode).toBe(409)
    expect(res.json().error.code).toBe('VIBE_CLOSING')
    const pub = await api('GET', `/vibes/${v.slug}`)
    const closeAt = new Date(pub.json().data.getsCloseAt).getTime()
    expect(new Date(pub.json().data.endsAt).getTime() - closeAt).toBe(60_000)
  })

  it('perto do fim, expires_at = endsAt - 20 s; PAID depois disso é estornado (não depende do job)', async () => {
    const v = await vibeEndingIn(5 * 60_000)
    const u = await userWithToken(t)
    const g = await placeGet(u.accessToken, v.id, 'd1-deadline-1')
    expect(g.statusCode).toBe(201)
    const [p] = await t.db.select().from(payments).where(eq(payments.id, g.json().data.payment.id))
    const [row] = await t.db.select().from(vibes).where(eq(vibes.id, v.id))
    expect(row!.endsAt.getTime() - p!.expiresAt.getTime()).toBe(20_000)

    // prazo passou, job ainda não rodou (pagamento segue PENDING): PAID não conta
    await t.db.update(payments).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(payments.id, p!.id))
    const pay = await api('POST', `/payments/${p!.id}/simulate`, u.accessToken, { status: 'PAID' })
    expect(pay.json().data.status).toBe('REFUNDED')
  })
})

describe('D3 — configurações', () => {
  it('só ADMIN lê/escreve; valida limites e grace <= cutoff; audita; bônus e cashback padrão passam a valer', async () => {
    const support = await userWithToken(t, { role: 'SUPPORT' })
    expect((await api('GET', '/admin/settings', support.accessToken)).statusCode).toBe(403)
    const cur = await api('GET', '/admin/settings', admin.accessToken)
    expect(cur.json().data).toMatchObject({ getCutoffSeconds: 60, paymentGraceSeconds: 40, defaultCashbackPercent: 40 })

    expect((await api('PATCH', '/admin/settings', admin.accessToken, { paymentGraceSeconds: 61 })).statusCode).toBe(400)
    expect((await api('PATCH', '/admin/settings', admin.accessToken, { defaultCashbackPercent: 101 })).statusCode).toBe(400)
    expect((await api('PATCH', '/admin/settings', admin.accessToken, { foo: 1 })).statusCode).toBe(400)

    const ok = await api('PATCH', '/admin/settings', admin.accessToken, { welcomeBonusCents: 250, defaultCashbackPercent: 30 })
    expect(ok.statusCode).toBe(200)
    const logs = await api('GET', '/admin/audit-logs?action=SETTINGS_UPDATED', admin.accessToken)
    expect(logs.json().data[0].metadata.changes.welcomeBonusCents).toEqual({ from: 0, to: 250 })

    const reg = await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      headers: CSRF,
      payload: { name: 'Bonus Teste', email: `bonus.${Date.now()}@teste.vibeget.dev`, password: 'Senha-Forte-Bonus-1', acceptTerms: true },
    })
    const w = await api('GET', '/me/wallet', reg.json().accessToken)
    expect(w.json().balanceCents).toBe(250)

    const { product } = await createLiveVibe(t)
    const nv = await api('POST', '/admin/vibes', admin.accessToken, {
      productId: product.id,
      slug: `d3-${Date.now()}`,
      minGetCents: 395,
      startsAt: new Date().toISOString(),
      endsAt: new Date(Date.now() + 86_400_000).toISOString(),
    })
    expect(nv.json().data.cashbackPercent).toBe(30)
    await api('PATCH', '/admin/settings', admin.accessToken, { welcomeBonusCents: 0, defaultCashbackPercent: 40 })
  })
})

describe('D4 — cupons', () => {
  it('resgate credita COUPON; repetir/inexistente/esgotado dão a MESMA resposta; lista de resgates', async () => {
    const code = `BEMVINDO${Date.now() % 100000}`
    const c = await api('POST', '/admin/coupons', admin.accessToken, { code: code.toLowerCase(), amountCents: 300, maxRedemptions: 2 })
    expect(c.statusCode).toBe(201)
    expect(c.json().data.code).toBe(code)
    expect((await api('POST', '/admin/coupons', admin.accessToken, { code, amountCents: 1 })).statusCode).toBe(409)

    const a = await userWithToken(t)
    const b = await userWithToken(t)
    const x = await userWithToken(t)
    const r1 = await api('POST', '/me/coupons/redeem', a.accessToken, { code: code.toLowerCase() })
    expect(r1.statusCode).toBe(200)
    expect(r1.json().data).toEqual({ amountCents: 300, balanceCents: 300 })
    const w = await api('GET', '/me/wallet', a.accessToken)
    expect(w.json().data[0]).toMatchObject({ type: 'COUPON', amountCents: 300 })

    const again = await api('POST', '/me/coupons/redeem', a.accessToken, { code })
    const unknown = await api('POST', '/me/coupons/redeem', a.accessToken, { code: 'NAOEXISTE123' })
    expect(again.statusCode).toBe(422)
    expect(again.json()).toEqual(unknown.json())
    expect((await api('POST', '/me/coupons/redeem', b.accessToken, { code })).statusCode).toBe(200)
    const exhausted = await api('POST', '/me/coupons/redeem', x.accessToken, { code })
    expect(exhausted.json()).toEqual(unknown.json())

    const list = await api('GET', `/admin/coupons/${c.json().data.id}/redemptions`, admin.accessToken)
    expect(list.json().meta.total).toBe(2)
    const locked = await api('PATCH', `/admin/coupons/${c.json().data.id}`, admin.accessToken, { amountCents: 999 })
    expect(locked.statusCode).toBe(409)
  })

  it('cupom no cadastro: válido aplica; inválido NÃO impede o cadastro (couponApplied:false)', async () => {
    const code = `CAD${Date.now() % 100000}`
    await api('POST', '/admin/coupons', admin.accessToken, { code, amountCents: 150, newAccountsOnly: true })
    const reg = (couponCode: string) =>
      t.app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        headers: CSRF,
        payload: {
          name: 'Cupom Teste',
          email: `cupom.${Date.now()}.${Math.random().toString(36).slice(2)}@teste.vibeget.dev`,
          password: 'Senha-Forte-Cupom-1',
          cpf: nextCpf(),
          acceptTerms: true,
          couponCode,
        },
      })
    const good = await reg(code)
    expect(good.statusCode).toBe(201)
    expect(good.json().couponApplied).toBe(true)
    const bad = await reg('!!! invalido !!!')
    expect(bad.statusCode).toBe(201)
    expect(bad.json().couponApplied).toBe(false)
    // conta antiga não resgata cupom "só contas novas"
    expect((await api('POST', '/me/coupons/redeem', admin.accessToken, { code })).statusCode).toBe(422)
  })
})

describe('D5 — upload, leilão e seed', () => {
  function multipart(filename: string, contentType: string, data: Buffer) {
    const boundary = '----vgtest' + Date.now()
    const head = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
    )
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`)
    return { payload: Buffer.concat([head, data, tail]), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } }
  }
  const upload = (token: string, body: ReturnType<typeof multipart>) =>
    t.app.inject({ method: 'POST', url: '/api/v1/admin/uploads', headers: { ...bearer(token), ...body.headers }, payload: body.payload })

  it('aceita PNG real (reprocessado), serve com headers seguros; recusa SVG, tipo falso e USER', async () => {
    const png = await sharp({ create: { width: 20, height: 10, channels: 3, background: '#e11' } }).png().toBuffer()
    const res = await upload(admin.accessToken, multipart('foto.png', 'image/png', png))
    expect(res.statusCode).toBe(201)
    const { url } = res.json().data
    expect(url).toMatch(/^\/uploads\/[0-9a-f-]{36}\.png$/)

    const file = await t.app.inject({ method: 'GET', url })
    expect(file.statusCode).toBe(200)
    expect(file.headers['content-type']).toBe('image/png')
    expect(file.headers['x-content-type-options']).toBe('nosniff')

    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
    expect((await upload(admin.accessToken, multipart('x.svg', 'image/svg+xml', svg))).statusCode).toBe(415)
    // Content-Type mentiroso: bytes de texto declarados como PNG
    expect((await upload(admin.accessToken, multipart('x.png', 'image/png', Buffer.from('not an image')))).statusCode).toBe(415)
    const user = await userWithToken(t)
    expect((await upload(user.accessToken, multipart('foto.png', 'image/png', png))).statusCode).toBe(403)
    expect((await t.app.inject({ method: 'GET', url: '/uploads/..%2F..%2Fpackage.json' })).statusCode).toBe(404)
  })

  it('arquivo acima de UPLOAD_MAX_BYTES → 413', async () => {
    const big = await sharp({ create: { width: 800, height: 800, channels: 3, background: '#123' } })
      .png({ compressionLevel: 0 })
      .toBuffer()
    expect(big.length).toBeGreaterThan(200_000)
    expect((await upload(admin.accessToken, multipart('big.png', 'image/png', big))).statusCode).toBe(413)
  })

  it('POST /admin/auctions cria produto + Vibe numa transação (slug de Vibe repetido não deixa produto órfão)', async () => {
    const s = `leilao-${Date.now()}`
    const body = (productSlug: string) => ({
      product: { slug: productSlug, name: 'Leilão Teste', category: 'games', originalPriceCents: 250_000, imageUrl: '/uploads/00000000-0000-4000-8000-000000000000.png' },
      vibe: { slug: s, status: 'LIVE', minGetCents: 395, startsAt: new Date().toISOString(), endsAt: new Date(Date.now() + 86_400_000).toISOString() },
    })
    const ok = await api('POST', '/admin/auctions', admin.accessToken, body(`${s}-p1`))
    expect(ok.statusCode).toBe(201)
    expect(ok.json().data.vibe.productId).toBe(ok.json().data.product.id)
    const dup = await api('POST', '/admin/auctions', admin.accessToken, body(`${s}-p2`))
    expect(dup.statusCode).toBe(409)
    const prods = await api('GET', `/admin/products?q=${encodeURIComponent('Leilão Teste')}&pageSize=100`, admin.accessToken)
    expect(prods.json().data.some((p: { slug: string }) => p.slug === `${s}-p2`)).toBe(false)
  })

  it('seed --demo é recusado em produção; seed normal grava settings e não cria produtos', async () => {
    const prod = loadEnv({ ...PROD_ENV, DATABASE_URL: 'postgres://a:b@h:5432/d', JWT_SECRET: 'x'.repeat(40), PAYMENT_WEBHOOK_SECRET: 'y'.repeat(40) })
    await expect(seed(t.db, { demo: true, env: prod })).rejects.toThrow(/produção/)
    const log = await seed(t.db, { env: t.env })
    expect(log.join('\n')).toMatch(/NÃO criados/)
  })
})
