/**
 * QA — sessões: refresh com rotação, reuso, logout, logout-all, cookie, access token revogável, JWT.
 */
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sessions, users } from '../src/db/schema.js'
import { sha256 } from '../src/lib/crypto.js'
import {
  bearer,
  createTestApp,
  createUser,
  CSRF,
  login,
  refreshCookieOf,
  userWithToken,
  type TestContext,
} from './helpers.js'
import { craftJwt, createProdApp, decodeJwt, get, send } from './qa-helpers.js'

let t: TestContext
beforeAll(async () => {
  t = await createTestApp()
})
afterAll(async () => {
  await t.close()
})

const refresh = (ctx: TestContext, token: string | undefined, headers: Record<string, string> = CSRF) =>
  ctx.app.inject({ method: 'POST', url: '/api/v1/auth/refresh', headers, ...(token ? { cookies: { vg_rt: token } } : {}) })

describe('cookie de refresh', () => {
  it('HttpOnly, SameSite=Strict, Path=/api/v1/auth, Secure (COOKIE_SECURE padrão true), expira em ~30 dias; token não vai no corpo', async () => {
    const u = await createUser(t)
    const { res } = await login(t, u.email)
    const c = res.cookies.find((x) => x.name === 'vg_rt')!
    expect(c.httpOnly).toBe(true)
    expect(c.sameSite).toBe('Strict')
    expect(c.path).toBe('/api/v1/auth')
    expect(c.secure).toBe(true)
    const days = (new Date(c.expires!).getTime() - Date.now()) / 86_400_000
    expect(days).toBeGreaterThan(29.9)
    expect(days).toBeLessThanOrEqual(30.01)
    expect(res.body).not.toContain(c.value)
    // guardado só como hash
    const [s] = await t.db.select().from(sessions).where(eq(sessions.tokenHash, sha256(c.value)))
    expect(s).toBeTruthy()
    const [plain] = await t.db.select().from(sessions).where(eq(sessions.tokenHash, c.value))
    expect(plain).toBeUndefined()
  })

  it('em produção o cookie sai com Secure', async () => {
    const p = await createProdApp()
    try {
      const u = await createUser(p)
      const res = await send(p, 'POST', '/auth/login', { email: u.email, password: u.password }, CSRF)
      expect(res.statusCode, res.body).toBe(200)
      expect(res.cookies.find((x) => x.name === 'vg_rt')!.secure).toBe(true)
    } finally {
      await p.close()
    }
  })

  it('COOKIE_SECURE=false (dev http) remove Secure — e é recusado em produção (ver security.test)', async () => {
    const d = await createTestApp({ env: { COOKIE_SECURE: 'false' } })
    try {
      const u = await createUser(d)
      const { res } = await login(d, u.email)
      expect(res.cookies.find((x) => x.name === 'vg_rt')!.secure).toBeFalsy()
    } finally {
      await d.close()
    }
  })
})

describe('POST /auth/refresh', () => {
  it('rotação: novo refresh e novo access; o antigo fica revogado e ligado ao novo (replaced_by)', async () => {
    const u = await userWithToken(t)
    const r = await refresh(t, u.refreshToken)
    expect(r.statusCode, r.body).toBe(200)
    const rt2 = refreshCookieOf(r)!
    expect(rt2).not.toBe(u.refreshToken)
    expect(r.json().accessToken).toEqual(expect.any(String))
    const [old] = await t.db.select().from(sessions).where(eq(sessions.tokenHash, sha256(u.refreshToken)))
    const [neu] = await t.db.select().from(sessions).where(eq(sessions.tokenHash, sha256(rt2)))
    expect(old!.revokedAt).not.toBeNull()
    expect(old!.replacedById).toBe(neu!.id)
    expect(neu!.familyId).toBe(old!.familyId)
    expect((await get(t, '/auth/me', r.json().accessToken)).statusCode).toBe(200)
  })

  it('REUSO do refresh antigo revoga a família inteira (refresh novo e access tokens da família param de valer)', async () => {
    const u = await userWithToken(t)
    const r1 = await refresh(t, u.refreshToken)
    const rt2 = refreshCookieOf(r1)!
    const at2 = r1.json().accessToken
    const reuse = await refresh(t, u.refreshToken)
    expect(reuse.statusCode).toBe(401)
    expect(reuse.json().error.code).toBe('INVALID_REFRESH_TOKEN')
    // cookie é limpo na resposta de erro
    const cleared = reuse.cookies.find((c) => c.name === 'vg_rt')
    expect(cleared?.value ?? '').toBe('')
    expect((await refresh(t, rt2)).statusCode).toBe(401)
    expect((await get(t, '/auth/me', at2)).statusCode).toBe(401)
    expect((await get(t, '/auth/me', u.accessToken)).statusCode).toBe(401)
    const active = (await t.db.select().from(sessions).where(eq(sessions.userId, u.id))).filter((s) => !s.revokedAt)
    expect(active).toHaveLength(0)
  })

  it('reuso numa família NÃO derruba outra família (outro dispositivo) do mesmo usuário', async () => {
    const u = await userWithToken(t)
    const other = await login(t, u.email)
    await refresh(t, u.refreshToken)
    await refresh(t, u.refreshToken) // reuso
    expect((await get(t, '/auth/me', other.accessToken)).statusCode).toBe(200)
    expect((await refresh(t, other.refreshToken)).statusCode).toBe(200)
  })

  it('sem cookie, cookie lixo, cookie gigante → 401', async () => {
    expect((await refresh(t, undefined)).statusCode).toBe(401)
    expect((await refresh(t, 'lixo')).statusCode).toBe(401)
    expect((await refresh(t, 'a'.repeat(500))).statusCode).toBe(401)
  })

  it('refresh expirado → 401', async () => {
    const u = await userWithToken(t)
    await t.db.update(sessions).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(sessions.tokenHash, sha256(u.refreshToken)))
    expect((await refresh(t, u.refreshToken)).statusCode).toBe(401)
  })

  it('CSRF: sem X-Requested-With → 403; Origin fora da allowlist → 403', async () => {
    const u = await userWithToken(t)
    expect((await refresh(t, u.refreshToken, {})).statusCode).toBe(403)
    expect((await refresh(t, u.refreshToken, { 'x-requested-with': 'fetch', origin: 'https://evil.example' })).statusCode).toBe(403)
    expect((await refresh(t, u.refreshToken, { 'x-requested-with': 'XMLHttpRequest', origin: 'http://localhost:5173' })).statusCode).toBe(403)
    // não consumiu o token
    expect((await refresh(t, u.refreshToken)).statusCode).toBe(200)
  })

  it('usuário suspenso não renova (401) e a família é revogada', async () => {
    const u = await userWithToken(t)
    await t.db.update(users).set({ status: 'SUSPENDED' }).where(eq(users.id, u.id))
    expect((await refresh(t, u.refreshToken)).statusCode).toBe(401)
    await t.db.update(users).set({ status: 'ACTIVE' }).where(eq(users.id, u.id))
    expect((await refresh(t, u.refreshToken)).statusCode).toBe(401)
  })

  /**
   * [QA-06] Corrida legítima: duas abas renovam ao mesmo tempo com o mesmo cookie.
   * Comportamento esperado de UX: o usuário continua logado em pelo menos uma aba.
   * Hoje a segunda chamada é tratada como REUSO e derruba a família inteira.
   */
  it('[QA-06] duas renovações simultâneas com o mesmo cookie não deveriam deslogar o usuário', async () => {
    const u = await userWithToken(t)
    const [a, b] = await Promise.all([refresh(t, u.refreshToken), refresh(t, u.refreshToken)])
    const winner = [a, b].find((r) => r.statusCode === 200)
    expect(winner).toBeTruthy()
    const stillLogged = await get(t, '/auth/me', winner!.json().accessToken)
    expect(stillLogged.statusCode).toBe(200)
  })
})

describe('logout / logout-all', () => {
  it('logout revoga a família: refresh e access token da sessão param na hora; cookie limpo', async () => {
    const u = await userWithToken(t)
    const res = await t.app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: CSRF, cookies: { vg_rt: u.refreshToken } })
    expect(res.statusCode).toBe(204)
    const c = res.cookies.find((x) => x.name === 'vg_rt')!
    expect(c.value).toBe('')
    expect(c.path).toBe('/api/v1/auth')
    expect((await refresh(t, u.refreshToken)).statusCode).toBe(401)
    expect((await get(t, '/auth/me', u.accessToken)).statusCode).toBe(401)
  })

  it('logout sem cookie é idempotente (204) e exige CSRF', async () => {
    expect((await send(t, 'POST', '/auth/logout', undefined, CSRF)).statusCode).toBe(204)
    expect((await send(t, 'POST', '/auth/logout')).statusCode).toBe(403)
  })

  it('logout-all derruba todas as sessões do usuário, não as de outros', async () => {
    const u = await userWithToken(t)
    const d2 = await login(t, u.email)
    const other = await userWithToken(t)
    const res = await send(t, 'POST', '/auth/logout-all', undefined, { ...bearer(u.accessToken), ...CSRF })
    expect(res.statusCode).toBe(204)
    expect((await get(t, '/auth/me', u.accessToken)).statusCode).toBe(401)
    expect((await get(t, '/auth/me', d2.accessToken)).statusCode).toBe(401)
    expect((await refresh(t, d2.refreshToken)).statusCode).toBe(401)
    expect((await get(t, '/auth/me', other.accessToken)).statusCode).toBe(200)
  })

  it('logout-all exige login e CSRF', async () => {
    const u = await userWithToken(t)
    expect((await send(t, 'POST', '/auth/logout-all', undefined, CSRF)).statusCode).toBe(401)
    expect((await send(t, 'POST', '/auth/logout-all', undefined, bearer(u.accessToken))).statusCode).toBe(403)
  })
})

describe('access token (JWT)', () => {
  it('payload tem sub, sid, iss, aud, exp em 15 min; não carrega dados pessoais', async () => {
    const u = await userWithToken(t)
    const p = decodeJwt(u.accessToken)
    expect(p).toMatchObject({ sub: u.id, iss: 'vibeget', aud: 'vibeget-api' })
    expect(typeof p.sid).toBe('string')
    expect((p.exp as number) - (p.iat as number)).toBe(900)
    expect(JSON.stringify(p)).not.toContain(u.email)
  })

  it('sem token, Bearer vazio, lixo → 401 INVALID_TOKEN/UNAUTHORIZED', async () => {
    expect((await get(t, '/auth/me')).statusCode).toBe(401)
    expect((await get(t, '/auth/me', undefined, { authorization: 'Bearer ' })).statusCode).toBe(401)
    expect((await get(t, '/auth/me', 'abc.def.ghi')).statusCode).toBe(401)
    expect((await get(t, '/auth/me', undefined, { authorization: 'Basic dXNlcjpwYXNz' })).statusCode).toBe(401)
  })

  it('token forjado com a chave correta é aceito só com sid ativo (controle do teste)', async () => {
    const u = await userWithToken(t)
    const real = decodeJwt(u.accessToken)
    const now = Math.floor(Date.now() / 1000)
    const ok = craftJwt({ sub: u.id, sid: real.sid, role: 'USER', iat: now, exp: now + 600, iss: 'vibeget', aud: 'vibeget-api' }, t.env.JWT_SECRET)
    expect((await get(t, '/auth/me', ok)).statusCode).toBe(200)
    const noSession = craftJwt({ sub: u.id, sid: randomUUID(), role: 'USER', iat: now, exp: now + 600, iss: 'vibeget', aud: 'vibeget-api' }, t.env.JWT_SECRET)
    expect((await get(t, '/auth/me', noSession)).statusCode).toBe(401)
  })

  it('alg=none, assinatura errada, expirado, iss/aud errados, alg HS512 → 401', async () => {
    const u = await userWithToken(t)
    const { sid } = decodeJwt(u.accessToken)
    const now = Math.floor(Date.now() / 1000)
    const base = { sub: u.id, sid, role: 'USER', iat: now, exp: now + 600, iss: 'vibeget', aud: 'vibeget-api' }
    const cases = {
      none: craftJwt(base, '', { alg: 'none', typ: 'JWT' }),
      wrongKey: craftJwt(base, 'outra-chave-qualquer-com-32-caracteres!!'),
      expired: craftJwt({ ...base, iat: now - 3600, exp: now - 60 }, t.env.JWT_SECRET),
      wrongIss: craftJwt({ ...base, iss: 'outro' }, t.env.JWT_SECRET),
      wrongAud: craftJwt({ ...base, aud: 'outro' }, t.env.JWT_SECRET),
      tamperedPayload: (() => {
        const [h, , s] = u.accessToken.split('.')
        const p = Buffer.from(JSON.stringify({ ...decodeJwt(u.accessToken), role: 'ADMIN' })).toString('base64url')
        return `${h}.${p}.${s}`
      })(),
    }
    for (const [name, tok] of Object.entries(cases)) {
      const res = await get(t, '/auth/me', tok)
      expect(res.statusCode, name).toBe(401)
    }
  })

  it('claim role=ADMIN num token válido de USER não dá acesso admin (role vem do banco)', async () => {
    const u = await userWithToken(t)
    const real = decodeJwt(u.accessToken)
    const forged = craftJwt({ ...real, role: 'ADMIN' }, t.env.JWT_SECRET)
    expect((await get(t, '/auth/me', forged)).statusCode).toBe(200)
    expect((await get(t, '/admin/dashboard', forged)).statusCode).toBe(403)
  })

  it('access token de usuário suspenso/excluído é recusado na hora', async () => {
    const u = await userWithToken(t)
    await t.db.update(users).set({ status: 'SUSPENDED' }).where(eq(users.id, u.id))
    expect((await get(t, '/auth/me', u.accessToken)).statusCode).toBe(401)
    await t.db.update(users).set({ status: 'DELETED' }).where(eq(users.id, u.id))
    expect((await get(t, '/auth/me', u.accessToken)).statusCode).toBe(401)
  })
})
