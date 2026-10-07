/**
 * QA — segurança transversal: CSRF, CORS, helmet, rate limit, erros, env, body limit, logs.
 */
import { Writable } from 'node:stream'
import { sql } from 'drizzle-orm'
import pino from 'pino'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { REDACT_PATHS } from '../src/app.js'
import { EnvError, loadEnv } from '../src/config/env.js'
import type { Mailer, SentMail } from '../src/lib/mailer.js'
import { bearer, createTestApp, createUser, CSRF, ORIGIN, userWithToken, type TestContext } from './helpers.js'
import { createProdApp, DATA_KEYS, get, PROD_ENV, send } from './qa-helpers.js'

let t: TestContext
beforeAll(async () => {
  t = await createTestApp()
})
afterAll(async () => {
  await t.close()
})

describe('CSRF nas rotas que usam cookie', () => {
  const EVIL = 'https://evil.example'
  const regBody = () => ({ name: 'Csrf Teste', email: `csrf.${Date.now()}.${Math.random()}@x.dev`, password: 'Senha-Forte-Csrf-1', acceptTerms: true })

  it.each([
    ['register', 'POST', '/auth/register'],
    ['login', 'POST', '/auth/login'],
    ['refresh', 'POST', '/auth/refresh'],
    ['logout', 'POST', '/auth/logout'],
  ] as const)('%s: sem X-Requested-With → 403; Origin fora da allowlist → 403; "null" → 403', async (_n, method, url) => {
    const body = url === '/auth/register' ? regBody() : url === '/auth/login' ? { email: 'a@b.dev', password: 'x' } : undefined
    const a = await send(t, method, url, body, {})
    const b = await send(t, method, url, body, { 'x-requested-with': 'fetch', origin: EVIL })
    const c = await send(t, method, url, body, { 'x-requested-with': 'fetch', origin: 'null' })
    const d = await send(t, method, url, body, { 'x-requested-with': 'fetch', origin: `${ORIGIN}.evil.example` })
    for (const r of [a, b, c, d]) {
      expect(r.statusCode).toBe(403)
      expect(r.json().error.code).toBe('CSRF_REJECTED')
    }
  })

  it('logout-all e PATCH /auth/password também exigem o header', async () => {
    const u = await userWithToken(t)
    expect((await send(t, 'POST', '/auth/logout-all', undefined, { ...bearer(u.accessToken), origin: ORIGIN })).statusCode).toBe(403)
    expect(
      (await send(t, 'PATCH', '/auth/password', { currentPassword: u.password, newPassword: 'Nova-Senha-Forte-9' }, { ...bearer(u.accessToken), 'x-requested-with': 'fetch', origin: EVIL }))
        .statusCode,
    ).toBe(403)
  })

  it('fora de produção Origin ausente é aceita; em produção é recusada', async () => {
    const u = await createUser(t)
    const dev = await send(t, 'POST', '/auth/login', { email: u.email, password: u.password }, { 'x-requested-with': 'fetch' })
    expect(dev.statusCode).toBe(200)
    const p = await createProdApp({ CORS_ORIGINS: ORIGIN })
    try {
      const pu = await createUser(p)
      const noOrigin = await send(p, 'POST', '/auth/login', { email: pu.email, password: pu.password }, { 'x-requested-with': 'fetch' })
      expect(noOrigin.statusCode).toBe(403)
      const ok = await send(p, 'POST', '/auth/login', { email: pu.email, password: pu.password }, CSRF)
      expect(ok.statusCode).toBe(200)
    } finally {
      await p.close()
    }
  })
})

describe('CORS', () => {
  it('preflight de origem permitida: ACAO = origem, credentials true, headers necessários liberados', async () => {
    const res = await t.app.inject({
      method: 'OPTIONS',
      url: '/api/v1/auth/login',
      headers: { origin: ORIGIN, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type,x-requested-with' },
    })
    expect(res.statusCode).toBeLessThan(300)
    expect(res.headers['access-control-allow-origin']).toBe(ORIGIN)
    expect(res.headers['access-control-allow-credentials']).toBe('true')
    expect(String(res.headers['access-control-allow-headers']).toLowerCase()).toContain('x-requested-with')
  })

  it('origem não permitida não recebe Access-Control-Allow-Origin (nem "*")', async () => {
    const res = await t.app.inject({
      method: 'OPTIONS',
      url: '/api/v1/auth/login',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
    })
    expect(res.headers['access-control-allow-origin']).toBeUndefined()
    const simple = await t.app.inject({ method: 'GET', url: '/api/v1/vibes', headers: { origin: 'https://evil.example' } })
    expect(simple.headers['access-control-allow-origin']).toBeUndefined()
  })
})

describe('headers de segurança (helmet)', () => {
  it('CSP restritiva, nosniff, frame bloqueado, sem x-powered-by; HSTS só em produção', async () => {
    const res = await get(t, '/health')
    expect(res.headers['content-security-policy']).toContain("default-src 'none'")
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'")
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(res.headers['x-frame-options']).toBeDefined()
    expect(res.headers['x-powered-by']).toBeUndefined()
    expect(res.headers['strict-transport-security']).toBeUndefined()
    const p = await createProdApp()
    try {
      const pr = await get(p, '/health')
      expect(pr.headers['strict-transport-security']).toMatch(/max-age=31536000/)
    } finally {
      await p.close()
    }
  })

  it('respostas de auth não são cacheáveis', async () => {
    const u = await createUser(t)
    const res = await send(t, 'POST', '/auth/login', { email: u.email, password: u.password }, CSRF)
    expect(res.headers['cache-control']).toBe('no-store')
  })
})

describe('rate limit', () => {
  let r: TestContext
  beforeAll(async () => {
    r = await createTestApp({ rateLimit: true })
  })
  afterAll(async () => {
    await r.close()
  })

  it('login: 10 por 15 min por IP; o 11º → 429 no formato padrão com Retry-After', async () => {
    const codes: number[] = []
    for (let i = 0; i < 11; i++) {
      const res = await send(r, 'POST', '/auth/login', { email: `x${i}@y.dev`, password: 'errada-errada' }, CSRF)
      codes.push(res.statusCode)
      if (i === 10) {
        expect(res.json()).toEqual({ error: { code: 'RATE_LIMITED', message: expect.any(String) } })
        expect(res.headers['retry-after']).toBeDefined()
      }
    }
    expect(codes.slice(0, 10).every((c) => c === 401)).toBe(true)
    expect(codes[10]).toBe(429)
  })

  it('register: 10 por hora; o 11º → 429', async () => {
    let last = 0
    for (let i = 0; i < 11; i++) {
      const res = await send(r, 'POST', '/auth/register', { name: 'Rate Limit', email: 'invalido', password: 'x', acceptTerms: true }, CSRF)
      last = res.statusCode
      if (i < 10) expect(res.statusCode).toBe(400)
    }
    expect(last).toBe(429)
  })

  it('forgot-password: 5 por 15 min; o 6º → 429', async () => {
    const codes: number[] = []
    for (let i = 0; i < 6; i++) codes.push((await send(r, 'POST', '/auth/forgot-password', { email: `f${i}@y.dev` })).statusCode)
    expect(codes).toEqual([202, 202, 202, 202, 202, 429])
  })

  it('limite é por IP: outro IP continua passando', async () => {
    const res = await r.app.inject({
      method: 'POST',
      url: '/api/v1/auth/forgot-password',
      remoteAddress: '10.9.8.7',
      payload: { email: 'outro@ip.dev' },
    })
    expect(res.statusCode).toBe(202)
  })

  it('X-Forwarded-For NÃO burla o limite com TRUST_PROXY=false', async () => {
    const res = await r.app.inject({
      method: 'POST',
      url: '/api/v1/auth/forgot-password',
      headers: { 'x-forwarded-for': '1.2.3.4' },
      payload: { email: 'xff@ip.dev' },
    })
    expect(res.statusCode).toBe(429)
  })
})

describe('erros não vazam detalhes', () => {
  it('erro interno (banco fora do ar) → 500 genérico, sem stack/SQL/params — dev e produção', async () => {
    for (const ctx of [await createTestApp(), await createProdApp()]) {
      const u = await userWithToken(ctx)
      await ctx.closeDb()
      const res = await get(ctx, '/me/dashboard', u.accessToken)
      expect(res.statusCode).toBe(500)
      expect(res.json()).toEqual({ error: { code: 'INTERNAL_ERROR', message: expect.any(String) } })
      expect(res.body).not.toMatch(/select|from|users|stack|at |\.ts|PGlite|drizzle|Failed query/i)
      await ctx.app.close()
    }
  })

  it('404 de rota e método não suportado seguem o formato padrão', async () => {
    const res = await t.app.inject({ method: 'PUT', url: '/api/v1/vibes' })
    expect(res.statusCode).toBe(404)
    expect(res.json().error.code).toBe('NOT_FOUND')
  })

  it('Content-Type não suportado → 415 no formato padrão', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { ...CSRF, 'content-type': 'text/xml' }, payload: '<x/>' })
    expect(res.statusCode).toBe(415)
    expect(res.json().error.code).toBe('UNSUPPORTED_MEDIA_TYPE')
  })

  it('corpo acima de 64 KB → 413 PAYLOAD_TOO_LARGE', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { ...CSRF, 'content-type': 'application/json' },
      payload: JSON.stringify({ email: 'a@b.dev', password: 'x'.repeat(70 * 1024) }),
    })
    expect(res.statusCode).toBe(413)
    expect(res.json().error.code).toBe('PAYLOAD_TOO_LARGE')
  })

  it('protótipo não é poluído via __proto__ / constructor no JSON', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { ...CSRF, 'content-type': 'application/json' },
      payload: '{"email":"a@b.dev","password":"x","__proto__":{"isAdmin":true}}',
    })
    expect(res.statusCode).toBe(400)
    expect(({} as Record<string, unknown>).isAdmin).toBeUndefined()
  })
})

describe('validação de env', () => {
  const good = { ...PROD_ENV }
  it('produção válida carrega', () => {
    expect(loadEnv(good).isProduction).toBe(true)
  })
  it.each([
    ['JWT_SECRET curto', { JWT_SECRET: 'curto-demais-1234567' }],
    ['JWT_SECRET ausente', { JWT_SECRET: '' }],
    ['DATABASE_URL ausente', { DATABASE_URL: '' }],
    ['PAYMENT_WEBHOOK_SECRET curto', { PAYMENT_WEBHOOK_SECRET: 'abc' }],
    ['COOKIE_SECURE=false', { COOKIE_SECURE: 'false' }],
    ['NODE_ENV desconhecido', { NODE_ENV: 'prod' }],
    ['PORT inválida', { PORT: '99999' }],
    ['booleano inválido', { COOKIE_SECURE: 'yes' }],
    ['DATA_KEY ausente', { DATA_KEY: '' }],
    ['DATA_KEY curta', { DATA_KEY: 'curto-demais-1234567' }],
    ['DATA_INDEX_KEY ausente', { DATA_INDEX_KEY: '' }],
    ['DATA_INDEX_KEY igual à DATA_KEY', { DATA_INDEX_KEY: PROD_ENV.DATA_KEY }],
    ['DATA_KEYS_OLD malformada', { DATA_KEYS_OLD: 'sem-dois-pontos' }],
  ])('produção recusa %s (EnvError, sem ecoar valores)', (_l, o) => {
    try {
      loadEnv({ ...good, ...o })
      expect.unreachable('deveria lançar')
    } catch (e) {
      expect(e).toBeInstanceOf(EnvError)
      const msg = (e as Error).message
      expect(msg).not.toContain(good.JWT_SECRET)
      expect(msg).not.toContain('curto-demais')
    }
  })

  /**
   * [QA-05] Fail-open: sem NODE_ENV o app sobe como "development" — com segredos de dev embutidos no código,
   * CSRF aceitando Origin ausente e a rota /payments/:id/simulate ATIVA (qualquer usuário marca o próprio
   * Get como pago sem pagar). Esperado: exigir NODE_ENV explícito ou um opt-in separado para a simulação.
   */
  it('[QA-05] sem NODE_ENV não deveria subir com simulação de pagamento e segredos de dev', () => {
    const env = loadEnv({ DATABASE_URL: 'postgres://x:y@db:5432/app', ...DATA_KEYS })
    const insecure = !env.isProduction && env.JWT_SECRET.startsWith('dev-only')
    expect(insecure).toBe(false)
  })
})

describe('logs', () => {
  function capture() {
    const lines: string[] = []
    const stream = new Writable({
      write(chunk, _enc, cb) {
        lines.push(chunk.toString())
        cb()
      },
    })
    const log = pino({ redact: { paths: REDACT_PATHS, censor: '[REDACTED]' } }, stream)
    return { log, lines }
  }

  it('redact cobre headers sensíveis e campos de senha/token no 1º nível de objetos', () => {
    const { log, lines } = capture()
    log.info({
      req: { headers: { authorization: 'Bearer SEGREDO-AT', cookie: 'vg_rt=SEGREDO-RT', 'x-signature': 'SEGREDO-SIG' } },
      body: { password: 'SEGREDO-PW', newPassword: 'SEGREDO-NPW', token: 'SEGREDO-TK', cpf: '12345678909' },
    })
    const out = lines.join('')
    for (const s of ['SEGREDO-AT', 'SEGREDO-RT', 'SEGREDO-SIG', 'SEGREDO-PW', 'SEGREDO-NPW', 'SEGREDO-TK', '12345678909']) {
      expect(out, s).not.toContain(s)
    }
  })

  /**
   * [QA-04] Erro de banco é logado com `req.log.error({ err })`; a mensagem do DrizzleQueryError traz
   * "Failed query ... params: ..." com os VALORES (e-mail, CPF, nome, hash argon2, hash de token).
   * O redact não alcança texto dentro de err.message / err.params.
   */
  it('[QA-04] erro de query não deveria levar parâmetros (PII) para o log', async () => {
    const tmp = await createTestApp()
    let err: unknown
    try {
      await tmp.db.execute(sql`SELECT ${'12345678909'}::int AS cpf_que_vaza, ${'maria@exemplo.com'} AS email`)
    } catch (e) {
      err = e
    } finally {
      await tmp.close()
    }
    expect(err).toBeTruthy()
    const { log, lines } = capture()
    log.error({ err }, 'erro não tratado')
    const out = lines.join('')
    expect(out).not.toContain('12345678909')
    expect(out).not.toContain('maria@exemplo.com')
  })
})

describe('forgot-password: tempo de resposta', () => {
  /**
   * [QA-08] Para e-mail existente o handler grava token + audit e AGUARDA o envio do e-mail; para e-mail
   * inexistente retorna na hora. Com um provedor real (100–500 ms) o tempo revela se a conta existe.
   * Esperado: tempo independente da existência (envio assíncrono/fila).
   */
  it('[QA-08] resposta não deveria depender de o e-mail existir (mailer lento)', async () => {
    const slow: Mailer = { send: (_m: SentMail) => new Promise((res) => setTimeout(res, 300)) }
    const s = await createTestApp({ mailer: slow })
    try {
      const u = await createUser(s)
      const t0 = performance.now()
      await send(s, 'POST', '/auth/forgot-password', { email: u.email })
      const known = performance.now() - t0
      const t1 = performance.now()
      await send(s, 'POST', '/auth/forgot-password', { email: `ghost.${Date.now()}@x.dev` })
      const unknown = performance.now() - t1
      expect(Math.abs(known - unknown)).toBeLessThan(150)
    } finally {
      await s.close()
    }
  })
})
