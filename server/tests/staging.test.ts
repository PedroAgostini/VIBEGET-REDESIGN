import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bearer, createLiveVibe, createTestApp, userWithToken, type TestContext } from './helpers.js'
import { PROD_ENV } from './qa-helpers.js'

/**
 * Ambiente de testes publicado (Vercel): fotos no banco, rota do Vercel Cron e opt-ins explícitos.
 * Roda com as regras de produção (PROD_ENV) para provar que os opt-ins só valem quando ligados.
 */

const CRON_SECRET = 'cron-secret-de-teste-0123456789'
let t: TestContext
let admin: Awaited<ReturnType<typeof userWithToken>>

beforeAll(async () => {
  t = await createTestApp({ env: { ...PROD_ENV, UPLOAD_STORAGE: 'db', PAYMENT_SIMULATION: 'true', CRON_SECRET } })
  admin = await userWithToken(t, { role: 'ADMIN' })
})
afterAll(async () => {
  await t.close()
})

function form(data: Buffer) {
  const b = 'stagingboundary'
  const payload = Buffer.concat([
    Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n`),
    data,
    Buffer.from(`\r\n--${b}--\r\n`),
  ])
  return { payload, headers: { 'content-type': `multipart/form-data; boundary=${b}` } }
}

describe('fotos no banco (UPLOAD_STORAGE=db)', () => {
  it('upload grava no banco e /uploads/:name serve a imagem com os headers seguros; nome desconhecido → 404', async () => {
    const png = await sharp({ create: { width: 30, height: 20, channels: 3, background: '#33aa66' } }).png().toBuffer()
    const f = form(png)
    const up = await t.app.inject({ method: 'POST', url: '/api/v1/admin/uploads', headers: { ...bearer(admin.accessToken), ...f.headers }, payload: f.payload })
    expect(up.statusCode, up.body).toBe(201)
    const url = up.json().data.url as string
    const img = await t.app.inject({ method: 'GET', url })
    expect(img.statusCode).toBe(200)
    expect(img.headers['content-type']).toBe('image/png')
    expect(img.headers['content-security-policy']).toContain('sandbox')
    expect((await sharp(img.rawPayload).metadata()).width).toBe(30)
    expect((await t.app.inject({ method: 'GET', url: '/uploads/00000000-0000-4000-8000-000000000000.png' })).statusCode).toBe(404)
  })
})

describe('Vercel Cron', () => {
  it('GET /api/v1/internal/jobs exige o CRON_SECRET (sem ou errado → 401) e roda jobs + retenção', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/internal/jobs' })).statusCode).toBe(401)
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/internal/jobs', headers: { authorization: 'Bearer errado' } })).statusCode).toBe(401)
    const ok = await t.app.inject({ method: 'GET', url: '/api/v1/internal/jobs', headers: { authorization: `Bearer ${CRON_SECRET}` } })
    expect(ok.statusCode, ok.body).toBe(200)
    expect(ok.json().data).toHaveProperty('jobs.settled')
    expect(ok.json().data).toHaveProperty('retention.sessionsDeleted')
  })

  it('sem CRON_SECRET a rota nem existe (404)', async () => {
    const plain = await createTestApp()
    try {
      expect((await plain.app.inject({ method: 'GET', url: '/api/v1/internal/jobs' })).statusCode).toBe(404)
    } finally {
      await plain.close()
    }
  })
})

describe('simulação de pagamento só com PAYMENT_SIMULATION', () => {
  it('com as regras de produção + PAYMENT_SIMULATION=true o simulate funciona; sem o opt-in não existe', async () => {
    expect(t.env.isProduction).toBe(true)
    expect(t.env.warnings.join(' ')).toContain('PAYMENT_SIMULATION')
    const u = await userWithToken(t)
    const { vibe } = await createLiveVibe(t)
    const g = await t.app.inject({
      method: 'POST',
      url: `/api/v1/vibes/${vibe.id}/gets`,
      headers: { ...bearer(u.accessToken), 'idempotency-key': 'staging-get-0001' },
      payload: { cashCents: 500, method: 'PIX' },
    })
    expect(g.statusCode, g.body).toBe(201)
    const sim = await t.app.inject({
      method: 'POST',
      url: `/api/v1/payments/${g.json().data.payment.id}/simulate`,
      headers: bearer(u.accessToken),
      payload: { status: 'PAID' },
    })
    expect(sim.statusCode, sim.body).toBe(200)

    const prod = await createTestApp({ env: { ...PROD_ENV } })
    try {
      expect(prod.env.allowPaymentSimulation).toBe(false)
    } finally {
      await prod.close()
    }
  })
})
