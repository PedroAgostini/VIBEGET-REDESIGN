import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bearer, createTestApp, CSRF, userWithToken, type TestContext } from './helpers.js'

/**
 * Matriz de acesso de TODAS as rotas registradas (coletadas no boot via onRoute).
 * Uma rota nova que esqueça autenticação ou papel quebra este teste.
 */

type Route = { method: string; url: string }

/** Rotas que um visitante sem login pode chamar (revisadas uma a uma). */
const PUBLIC = new Set([
  'GET /api/v1/health',
  'POST /api/v1/auth/register',
  'POST /api/v1/auth/login',
  'POST /api/v1/auth/refresh',
  'POST /api/v1/auth/logout',
  'POST /api/v1/auth/verify-email',
  'POST /api/v1/auth/forgot-password',
  'POST /api/v1/auth/reset-password',
  'GET /api/v1/vibes',
  'GET /api/v1/vibes/:slug',
  // contador de visualizações da página da Vibe (CSRF + 30/min por IP, sem dado pessoal)
  'POST /api/v1/vibes/:slug/view',
  'GET /api/v1/market/listings',
  'GET /api/v1/getcoin-packages',
  // webhook do provedor de pagamento: autenticado por assinatura HMAC, não por login
  'POST /api/v1/payments/webhook',
  'GET /api/v1/cep/:cep',
  // fotos de produto enviadas pelo admin
  'GET /uploads/:name',
])

/** Leituras do /admin que o SUPPORT também não pode ver (dinheiro e configuração). */
const ADMIN_ONLY_READS = new Set([
  'GET /api/v1/admin/settings',
  'GET /api/v1/admin/settings/withdrawals',
  'GET /api/v1/admin/settings/getcoin',
  'GET /api/v1/admin/settings/market',
  'GET /api/v1/admin/getcoin-packages',
])

const UUID = '00000000-0000-4000-8000-000000000000'
const fill = (url: string) =>
  url
    .replace(/:(\w+)/g, (_m, name: string) => (/id$/i.test(name) ? UUID : name === 'cep' ? '01310100' : 'nao-existe'))
    .replace('*', 'nao-existe.png')

let t: TestContext
const routes: Route[] = []
let user: Awaited<ReturnType<typeof userWithToken>>
let support: Awaited<ReturnType<typeof userWithToken>>

beforeAll(async () => {
  const seen = new Set<string>()
  t = await createTestApp({
    onRoute: (r) => {
      for (const method of [r.method].flat()) {
        const k = `${method} ${r.url}`
        if (method === 'HEAD' || method === 'OPTIONS' || seen.has(k)) continue
        seen.add(k)
        routes.push({ method, url: r.url })
      }
    },
  })
  user = await userWithToken(t)
  support = await userWithToken(t, { role: 'SUPPORT' })
})
afterAll(async () => {
  await t.close()
})

const call = (r: Route, token?: string) =>
  t.app.inject({
    method: r.method as 'GET',
    url: fill(r.url),
    headers: { ...CSRF, ...(token ? bearer(token) : {}) },
    ...(r.method === 'GET' || r.method === 'DELETE' ? {} : { payload: {} }),
  })
const key = (r: Route) => `${r.method} ${r.url}`

describe('matriz de acesso (todas as rotas)', () => {
  it('coletou as rotas da API', () => {
    expect(routes.length).toBeGreaterThan(60)
  })

  it('visitante sem login só alcança as rotas públicas revisadas', async () => {
    const open: string[] = []
    for (const r of routes) {
      const res = await call(r)
      if (res.statusCode !== 401) open.push(`${key(r)} -> ${res.statusCode}`)
    }
    const unexpected = open.filter((o) => !PUBLIC.has(o.split(' -> ')[0]!))
    expect(unexpected, `rotas abertas sem login:\n${unexpected.join('\n')}`).toEqual([])
    // A lista pública não pode ter sobras (rota removida ou renomeada).
    const known = new Set(routes.map(key))
    expect([...PUBLIC].filter((p) => !known.has(p))).toEqual([])
  })

  it('usuário comum recebe 403 em todo /admin', async () => {
    const leaks: string[] = []
    for (const r of routes.filter((x) => x.url.startsWith('/api/v1/admin'))) {
      const res = await call(r, user.accessToken)
      if (res.statusCode !== 403) leaks.push(`${key(r)} -> ${res.statusCode}`)
    }
    expect(leaks, `rotas de admin acessíveis a usuário comum:\n${leaks.join('\n')}`).toEqual([])
  })

  it('SUPPORT só lê no /admin: toda escrita e as leituras de configuração/pacotes dão 403', async () => {
    const leaks: string[] = []
    for (const r of routes.filter((x) => x.url.startsWith('/api/v1/admin'))) {
      const res = await call(r, support.accessToken)
      const mustBlock = r.method !== 'GET' || ADMIN_ONLY_READS.has(key(r))
      if (mustBlock && res.statusCode !== 403) leaks.push(`${key(r)} -> ${res.statusCode}`)
      if (!mustBlock && (res.statusCode === 401 || res.statusCode === 403)) leaks.push(`${key(r)} -> ${res.statusCode} (deveria ler)`)
    }
    expect(leaks, leaks.join('\n')).toEqual([])
  })

  it('token adulterado, sem assinatura ou de outro emissor é recusado', async () => {
    const me = { method: 'GET', url: '/api/v1/auth/me' }
    const [h, p, s] = user.accessToken.split('.')
    const forged = `${h}.${Buffer.from(JSON.stringify({ sub: user.id, sid: 'x', role: 'ADMIN' })).toString('base64url')}.${s}`
    const none = `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${p}.`
    for (const tok of [forged, none, 'abc', `${user.accessToken}x`]) {
      expect((await call(me, tok)).statusCode).toBe(401)
    }
    const otherIssuer = t.app.jwt.sign({ sub: user.id, sid: 'x', role: 'ADMIN' } as never, { iss: 'outro' } as never)
    expect((await call(me, otherIssuer)).statusCode).toBe(401)
  })
})
