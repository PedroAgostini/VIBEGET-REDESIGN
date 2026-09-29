/**
 * QA — D5: upload de imagem (arquivos maliciosos), /uploads público, leilão transacional e seed --demo.
 */
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { crc32 } from 'node:zlib'
import { eq } from 'drizzle-orm'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadEnv } from '../src/config/env.js'
import { products, vibes } from '../src/db/schema.js'
import { seed } from '../src/db/seed.js'
import { bearer, createTestApp, userWithToken, type TestContext } from './helpers.js'
import { PROD_ENV, send } from './qa-helpers.js'

let t: TestContext
let admin: Awaited<ReturnType<typeof userWithToken>>
const uploadDir = mkdtempSync(path.join(os.tmpdir(), 'vg-qa-up-'))
const MAX = 300_000

beforeAll(async () => {
  t = await createTestApp({ env: { UPLOAD_DIR: uploadDir, UPLOAD_MAX_BYTES: String(MAX) } })
  admin = await userWithToken(t, { role: 'ADMIN' })
})
afterAll(async () => {
  await t.close()
  rmSync(uploadDir, { recursive: true, force: true })
})

function form(data: Buffer, filename = 'foto.png', type = 'image/png', extraFile?: Buffer) {
  const b = '----qa' + Math.random().toString(16).slice(2)
  const part = (d: Buffer, n: string) =>
    Buffer.concat([Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="${n}"\r\nContent-Type: ${type}\r\n\r\n`), d, Buffer.from('\r\n')])
  const body = Buffer.concat([part(data, filename), ...(extraFile ? [part(extraFile, 'dois.png')] : []), Buffer.from(`--${b}--\r\n`)])
  return { payload: body, headers: { 'content-type': `multipart/form-data; boundary=${b}` } }
}
const upload = (token: string | undefined, f: ReturnType<typeof form>) =>
  t.app.inject({ method: 'POST', url: '/api/v1/admin/uploads', headers: { ...(token ? bearer(token) : {}), ...f.headers }, payload: f.payload })

const png = (w = 40, h = 30) => sharp({ create: { width: w, height: h, channels: 3, background: '#3366ff' } }).png().toBuffer()

/** PNG só com IHDR declarando dimensões gigantes (decompression bomb) — sem decodificar nada. */
function pngHeaderOnly(width: number, height: number) {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(td) >>> 0)
    return Buffer.concat([len, td, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', Buffer.from([0x78, 0x9c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01])), chunk('IEND', Buffer.alloc(0))])
}

describe('POST /admin/uploads', () => {
  it('PNG válido → 201 com URL gerada pelo servidor; GET devolve a imagem com headers seguros', async () => {
    const res = await upload(admin.accessToken, form(await png(), '../../etc/passwd.png'))
    expect(res.statusCode, res.body).toBe(201)
    const { url, contentType } = res.json().data
    expect(url).toMatch(/^\/uploads\/[0-9a-f-]{36}\.png$/)
    expect(contentType).toBe('image/png')
    expect(readdirSync(uploadDir)).toContain(url.split('/').pop())
    const g = await t.app.inject({ method: 'GET', url })
    expect(g.statusCode).toBe(200)
    expect(g.headers['content-type']).toBe('image/png')
    expect(g.headers['x-content-type-options']).toBe('nosniff')
    expect(g.headers['content-security-policy']).toContain('sandbox')
    expect(g.headers['content-security-policy']).toContain("default-src 'none'")
    expect((await sharp(g.rawPayload).metadata()).format).toBe('png')
  })

  it('JPEG com EXIF/GPS sai sem metadados', async () => {
    const jpg = await sharp({ create: { width: 20, height: 20, channels: 3, background: '#ff0000' } })
      .jpeg()
      .withExif({ IFD0: { Artist: 'SEGREDO-EXIF', Copyright: 'x' } })
      .toBuffer()
    expect(jpg.includes(Buffer.from('SEGREDO-EXIF'))).toBe(true)
    const res = await upload(admin.accessToken, form(jpg, 'a.jpg', 'image/jpeg'))
    expect(res.statusCode, res.body).toBe(201)
    const g = await t.app.inject({ method: 'GET', url: res.json().data.url })
    expect(g.rawPayload.includes(Buffer.from('SEGREDO-EXIF'))).toBe(false)
    expect((await sharp(g.rawPayload).metadata()).exif).toBeUndefined()
  })

  it.each([
    ['SVG com script', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'x.svg', 'image/svg+xml'],
    ['HTML renomeado para .png', Buffer.from('<html><body><script>alert(document.cookie)</script></body></html>'), 'x.png', 'image/png'],
    ['magic bytes de PNG + lixo', Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('<script>alert(1)</script>'.repeat(10))]), 'x.png', 'image/png'],
    ['magic de JPEG + HTML', Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from('<html><script>1</script>')]), 'x.jpg', 'image/jpeg'],
    ['GIF (não suportado)', Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;', 'latin1'), 'x.gif', 'image/gif'],
    ['vazio', Buffer.alloc(0), 'x.png', 'image/png'],
  ])('%s → 415 e nada gravado', async (_l, data, name, type) => {
    const before = readdirSync(uploadDir).length
    const res = await upload(admin.accessToken, form(data, name, type))
    expect([400, 415], res.body).toContain(res.statusCode)
    expect(readdirSync(uploadDir).length).toBe(before)
  })

  it('poliglota (PNG válido + HTML depois do IEND) → aceito, mas re-codificado sem o payload', async () => {
    const poly = Buffer.concat([await png(), Buffer.from('<html><script>alert(1)</script></html>')])
    const res = await upload(admin.accessToken, form(poly))
    expect(res.statusCode, res.body).toBe(201)
    const g = await t.app.inject({ method: 'GET', url: res.json().data.url })
    expect(g.rawPayload.includes(Buffer.from('<script>'))).toBe(false)
  })

  it('decompression bomb (IHDR 100000×100000) → 415 sem estourar memória', async () => {
    const res = await upload(admin.accessToken, form(pngHeaderOnly(100_000, 100_000)))
    expect(res.statusCode).toBe(415)
  })

  it('imagem grande (dentro do limite de bytes) é reduzida para no máx. 2400 px', async () => {
    const big = await sharp({ create: { width: 3000, height: 100, channels: 3, background: '#000' } }).png().toBuffer()
    const res = await upload(admin.accessToken, form(big))
    expect(res.statusCode, res.body).toBe(201)
    expect(res.json().data.width).toBe(2400)
  })

  it('arquivo acima de UPLOAD_MAX_BYTES → 413; dois arquivos → no máx. 1 gravado; sem multipart → 415', async () => {
    const huge = Buffer.concat([await png(), Buffer.alloc(MAX + 10)])
    expect((await upload(admin.accessToken, form(huge))).statusCode).toBe(413)
    // dois arquivos: só o primeiro é processado (limite files:1), nunca dois gravados
    const before = readdirSync(uploadDir).length
    const two = await upload(admin.accessToken, form(await png(), 'a.png', 'image/png', await png()))
    expect(two.statusCode).toBeLessThan(500)
    expect(readdirSync(uploadDir).length - before).toBeLessThanOrEqual(1)
    const json = await send(t, 'POST', '/admin/uploads', { url: 'x' }, bearer(admin.accessToken))
    expect(json.statusCode).toBe(415)
  })

  it('RBAC: sem token 401; USER e SUPPORT 403', async () => {
    const f = form(await png())
    expect((await upload(undefined, f)).statusCode).toBe(401)
    for (const role of ['USER', 'SUPPORT'] as const) {
      const u = await userWithToken(t, { role })
      expect((await upload(u.accessToken, form(await png()))).statusCode).toBe(403)
    }
  })
})

describe('GET /uploads/:name', () => {
  it.each([
    '/uploads/..%2f..%2fpackage.json',
    '/uploads/../package.json',
    '/uploads/%2e%2e%2f.env',
    '/uploads/..\\..\\.env',
    '/uploads/00000000-0000-0000-0000-000000000000.png',
    '/uploads/00000000-0000-0000-0000-000000000000.svg',
    '/uploads/00000000-0000-0000-0000-000000000000.png%00.txt',
    '/uploads/',
  ])('%s → 404 sem conteúdo do disco', async (url) => {
    const res = await t.app.inject({ method: 'GET', url })
    expect(res.statusCode, url).toBe(404)
    expect(res.body).not.toMatch(/"name"|DATABASE_URL|JWT_SECRET/)
  })
})

describe('POST /admin/auctions', () => {
  const body = (o: { pslug?: string; vslug?: string; vibe?: object; product?: object } = {}) => ({
    product: { slug: o.pslug ?? `ap-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, name: 'Produto Leilão', category: 'audio', originalPriceCents: 10_000, ...o.product },
    vibe: {
      slug: o.vslug ?? `av-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      minGetCents: 395,
      startsAt: new Date(Date.now() + 3600_000).toISOString(),
      endsAt: new Date(Date.now() + 7200_000).toISOString(),
      ...o.vibe,
    },
  })

  it('cria produto + Vibe (cashback padrão das configurações) e audita', async () => {
    const res = await send(t, 'POST', '/admin/auctions', body(), bearer(admin.accessToken))
    expect(res.statusCode, res.body).toBe(201)
    const { product, vibe } = res.json().data
    expect(vibe.productId).toBe(product.id)
    expect(vibe.cashbackPercent).toBe(40)
  })

  it('slug de Vibe repetido → 409 e o produto NÃO fica órfão', async () => {
    const first = await send(t, 'POST', '/admin/auctions', body(), bearer(admin.accessToken))
    const vslug = first.json().data.vibe.slug
    const pslug = `orfao-${Date.now()}`
    const res = await send(t, 'POST', '/admin/auctions', body({ pslug, vslug }), bearer(admin.accessToken))
    expect(res.statusCode).toBe(409)
    expect(await t.db.select().from(products).where(eq(products.slug, pslug))).toHaveLength(0)
  })

  it('Vibe inválida (LIVE com fim no passado, datas invertidas) → 400 sem produto; imageUrl maliciosa → 400', async () => {
    for (const [pslug, extra] of [
      [`o1-${Date.now()}`, { vibe: { status: 'LIVE', startsAt: new Date(Date.now() - 7200_000).toISOString(), endsAt: new Date(Date.now() - 3600_000).toISOString() } }],
      [`o2-${Date.now()}`, { vibe: { endsAt: new Date(Date.now() + 1000).toISOString() } }],
      [`o3-${Date.now()}`, { product: { imageUrl: '//evil.com/x.png' } }],
    ] as const) {
      const res = await send(t, 'POST', '/admin/auctions', body({ pslug, ...extra }), bearer(admin.accessToken))
      expect(res.statusCode, res.body).toBe(400)
      expect(await t.db.select().from(products).where(eq(products.slug, pslug))).toHaveLength(0)
    }
  })

  it('RBAC: USER e SUPPORT → 403; campo extra (winnerGetId) → 400', async () => {
    for (const role of ['USER', 'SUPPORT'] as const) {
      const u = await userWithToken(t, { role })
      expect((await send(t, 'POST', '/admin/auctions', body(), bearer(u.accessToken))).statusCode).toBe(403)
    }
    const b = body({ vibe: { winnerGetId: '00000000-0000-4000-8000-000000000000' } })
    expect((await send(t, 'POST', '/admin/auctions', b, bearer(admin.accessToken))).statusCode).toBe(400)
    void vibes
  })
})

describe('seed', () => {
  it('--demo é recusado em produção e sem NODE_ENV; sem --demo não cria produtos', async () => {
    const tmp = await createTestApp()
    try {
      await expect(seed(tmp.db, { demo: true, env: loadEnv({ ...PROD_ENV }) })).rejects.toThrow()
      await expect(seed(tmp.db, { demo: true, env: loadEnv({ DATABASE_URL: PROD_ENV.DATABASE_URL }) })).rejects.toThrow()
      await seed(tmp.db, { demo: false, env: tmp.env })
      expect(await tmp.db.select().from(products)).toHaveLength(0)
      await seed(tmp.db, { demo: true, env: tmp.env })
      expect((await tmp.db.select().from(products)).length).toBe(8)
    } finally {
      await tmp.close()
    }
  })
})
