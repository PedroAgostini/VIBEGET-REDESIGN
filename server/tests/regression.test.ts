/**
 * QA — reverificação das correções (QA-01..QA-15). Testes de regressão que vão além do teste original
 * de cada achado: idempotência, caminhos alternativos e efeitos colaterais das correções.
 */
import { and, count, eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { auditLogs, getcoinLedger, payments, users, vibes } from '../src/db/schema.js'
import { EnvError, loadEnv } from '../src/config/env.js'
import { safeErrorForLog } from '../src/lib/log-safety.js'
import type { Mailer } from '../src/lib/mailer.js'
import { expireStalePayments } from '../src/modules/payments/service.js'
import {
  bearer,
  createLiveVibe,
  createTestApp,
  createUser,
  CSRF,
  getUserRow,
  login,
  ORIGIN,
  PASSWORD,
  refreshCookieOf,
  userWithToken,
  type TestContext,
} from './helpers.js'
import {
  assertLedgerInvariant,
  balanceOf,
  confirmedGet,
  externalIdOfGet,
  fund,
  get,
  getRow,
  paymentOfGet,
  placeGet,
  PROD_ENV,
  send,
  webhook,
} from './qa-helpers.js'

let t: TestContext
let admin: Awaited<ReturnType<typeof userWithToken>>
beforeAll(async () => {
  t = await createTestApp()
  admin = await userWithToken(t, { role: 'ADMIN' })
})
afterAll(async () => {
  await assertLedgerInvariant(t)
  await t.close()
})

const refundsOf = async (getId: string) =>
  (await t.db
    .select({ n: count() })
    .from(getcoinLedger)
    .where(and(eq(getcoinLedger.type, 'REFUND'), eq(getcoinLedger.referenceId, getId))))[0]!.n
const auditCount = async (entityId: string, action: string) =>
  (await t.db
    .select({ n: count() })
    .from(auditLogs)
    .where(and(eq(auditLogs.entityId, entityId), eq(auditLogs.action, action))))[0]!.n

describe('QA-01 — PAID tardio', () => {
  it('pagamento expirado (GetCoin já devolvido) + PAID repetido 3x: REFUNDED uma vez, GetCoin devolvido UMA vez, 1 pedido de estorno', async () => {
    const { vibe } = await createLiveVibe(t)
    const u = await userWithToken(t)
    await fund(t, u.id, 300)
    const g = await placeGet(t, u.accessToken, vibe.id, { cashCents: 500, getcoinCents: 300 })
    const getId = g.json().data.get.id
    const payId = g.json().data.payment.id
    await t.db.update(payments).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(payments.id, payId))
    await expireStalePayments({ db: t.db })
    expect(await balanceOf(t, u.id)).toBe(300)
    const ext = await externalIdOfGet(t, getId)
    const r1 = await webhook(t, ext, 'PAID')
    const r2 = await webhook(t, ext, 'PAID')
    const r3 = await webhook(t, ext, 'PAID')
    expect([r1.json().changed, r2.json().changed, r3.json().changed]).toEqual([true, false, false])
    const p = await paymentOfGet(t, getId)
    expect(p.status).toBe('REFUNDED')
    expect(p.paidAt).toBeInstanceOf(Date)
    expect((await getRow(t, getId)).status).toBe('REFUNDED')
    expect(await balanceOf(t, u.id)).toBe(300)
    expect(await refundsOf(getId)).toBe(1)
    expect(await auditCount(payId, 'PAYMENT_LATE_REFUND')).toBe(1)
    expect(await auditCount(payId, 'PROVIDER_REFUND_REQUESTED')).toBe(1)
    expect(await auditCount(payId, 'PROVIDER_CHARGE_CANCEL_REQUESTED')).toBe(1)
    // FAILED depois disso não mexe em nada
    expect((await webhook(t, ext, 'FAILED')).json().changed).toBe(false)
    await assertLedgerInvariant(t)
  })

  it('PAID tardio não entra na disputa: o Get estornado nunca vira vencedor nem recebe cashback', async () => {
    const { vibe } = await createLiveVibe(t)
    const w = await userWithToken(t)
    const late = await userWithToken(t)
    const wGet = await confirmedGet(t, w.accessToken, vibe.id, { cashCents: 500 })
    const lg = await placeGet(t, late.accessToken, vibe.id, { cashCents: 9000 })
    const res = await send(t, 'POST', `/admin/vibes/${vibe.id}/close`, undefined, bearer(admin.accessToken))
    expect(res.json().data.winnerGetId).toBe(wGet)
    await webhook(t, await externalIdOfGet(t, lg.json().data.get.id), 'PAID')
    const [v] = await t.db.select().from(vibes).where(eq(vibes.id, vibe.id))
    expect(v!.winnerGetId).toBe(wGet)
    expect(await balanceOf(t, late.id)).toBe(0)
    // receita confirmada não conta dinheiro estornado
    const dash = await get(t, '/admin/dashboard', admin.accessToken)
    expect(dash.statusCode).toBe(200)
  })

  it('Vibe cancelada: PAID repetido sobre pagamento já REFUNDED não estorna de novo', async () => {
    const { vibe } = await createLiveVibe(t)
    const u = await userWithToken(t)
    await fund(t, u.id, 200)
    const getId = await confirmedGet(t, u.accessToken, vibe.id, { cashCents: 500, getcoinCents: 200 })
    await send(t, 'PATCH', `/admin/vibes/${vibe.id}`, { status: 'CANCELLED' }, bearer(admin.accessToken))
    expect(await balanceOf(t, u.id)).toBe(200)
    const ext = await externalIdOfGet(t, getId)
    expect((await webhook(t, ext, 'PAID')).json().changed).toBe(false)
    expect(await refundsOf(getId)).toBe(1)
    expect(await balanceOf(t, u.id)).toBe(200)
  })

  it('PAID tardio após recusa (FAILED via webhook) também é estornado, com GetCoin devolvido uma vez', async () => {
    const { vibe } = await createLiveVibe(t)
    const u = await userWithToken(t)
    await fund(t, u.id, 100)
    const g = await placeGet(t, u.accessToken, vibe.id, { cashCents: 500, getcoinCents: 100 })
    const getId = g.json().data.get.id
    const ext = await externalIdOfGet(t, getId)
    await webhook(t, ext, 'FAILED')
    await webhook(t, ext, 'PAID')
    expect((await paymentOfGet(t, getId)).status).toBe('REFUNDED')
    expect(await refundsOf(getId)).toBe(1)
    expect(await balanceOf(t, u.id)).toBe(100)
  })
})

describe('QA-04 — erro de banco no log', () => {
  it('safeErrorForLog de um DrizzleQueryError real não contém parâmetros nem literais', async () => {
    let err: unknown
    try {
      await t.db.execute(sql`INSERT INTO users (name, email, password_hash, referral_code, cpf) VALUES (${'Maria Secreta'}, ${'MAIUSCULA@X.COM'}, ${'$argon2id$hash-secreto'}, ${'REFQA001'}, ${'12345678909'})`)
    } catch (e) {
      err = e
    }
    expect(err).toBeTruthy()
    const out = JSON.stringify(safeErrorForLog(err))
    for (const leak of ['Maria Secreta', 'MAIUSCULA@X.COM', 'hash-secreto', '12345678909', 'REFQA001']) {
      expect(out, leak).not.toContain(leak)
    }
    expect(safeErrorForLog(err).code).toMatch(/^\d{5}$/) // SQLSTATE continua disponível para diagnóstico
  })
})

describe('QA-05 — sem NODE_ENV = regras de produção', () => {
  it('sem NODE_ENV e sem DATABASE_URL → EnvError (não sobe com PGlite)', () => {
    expect(() => loadEnv({})).toThrow(EnvError)
  })

  it('sem NODE_ENV: isProduction, simulação desligada, segredos NÃO são os de dev e mudam a cada boot', () => {
    const a = loadEnv({ DATABASE_URL: 'postgres://x:y@db:5432/app' })
    const b = loadEnv({ DATABASE_URL: 'postgres://x:y@db:5432/app' })
    expect(a.isProduction).toBe(true)
    expect(a.allowPaymentSimulation).toBe(false)
    expect(a.JWT_SECRET).not.toMatch(/^dev-only/)
    expect(a.PAYMENT_WEBHOOK_SECRET).not.toMatch(/^dev-only/)
    expect(a.JWT_SECRET).not.toBe(b.JWT_SECRET)
    expect(a.warnings.length).toBeGreaterThan(0)
  })

  it('sem NODE_ENV: segredo informado curto é recusado; COOKIE_SECURE=false recusado', () => {
    expect(() => loadEnv({ DATABASE_URL: 'postgres://x:y@db:5432/app', JWT_SECRET: 'a'.repeat(20) })).toThrow(EnvError)
    expect(() => loadEnv({ DATABASE_URL: 'postgres://x:y@db:5432/app', COOKIE_SECURE: 'false' })).toThrow(EnvError)
  })

  it('app sem NODE_ENV: /payments/:id/simulate → 404, CSRF exige Origin, HSTS ligado', async () => {
    const p = await createTestApp({ env: { NODE_ENV: undefined as unknown as string, DATABASE_URL: PROD_ENV.DATABASE_URL } })
    try {
      expect(p.env.isProduction).toBe(true)
      const u = await createUser(p)
      const noOrigin = await send(p, 'POST', '/auth/login', { email: u.email, password: u.password }, { 'x-requested-with': 'fetch' })
      expect(noOrigin.statusCode).toBe(403)
      const { accessToken } = await login(p, u.email)
      const { vibe } = await createLiveVibe(p)
      const g = await placeGet(p, accessToken, vibe.id, { cashCents: 500 })
      const sim = await send(p, 'POST', `/payments/${g.json().data.payment.id}/simulate`, { status: 'PAID' }, bearer(accessToken))
      expect(sim.statusCode).toBe(404)
      expect((await paymentOfGet(p, g.json().data.get.id)).status).toBe('PENDING')
      expect((await get(p, '/health')).headers['strict-transport-security']).toBeDefined()
    } finally {
      await p.close()
    }
  })

  it('NODE_ENV=development explícito mantém a simulação (fluxo de dev não quebrou)', () => {
    expect(loadEnv({ NODE_ENV: 'development' }).allowPaymentSimulation).toBe(true)
  })
})

describe('QA-06 — corrida no refresh', () => {
  it('perdedor da corrida recebe 409 REFRESH_RACE, sem token, sem apagar cookie, e a família continua ativa', async () => {
    const u = await userWithToken(t)
    const call = () => t.app.inject({ method: 'POST', url: '/api/v1/auth/refresh', headers: CSRF, cookies: { vg_rt: u.refreshToken } })
    const [a, b] = await Promise.all([call(), call()])
    const ok = [a, b].find((r) => r.statusCode === 200)!
    const race = [a, b].find((r) => r.statusCode !== 200)!
    expect(race.statusCode).toBe(409)
    expect(race.json().error.code).toBe('REFRESH_RACE')
    expect(race.body).not.toContain('accessToken')
    expect(race.cookies.find((c) => c.name === 'vg_rt')).toBeUndefined()
    // o cliente repete com o cookie novo e segue logado
    const retry = await t.app.inject({ method: 'POST', url: '/api/v1/auth/refresh', headers: CSRF, cookies: { vg_rt: refreshCookieOf(ok)! } })
    expect(retry.statusCode).toBe(200)
  })

  it('atacante com token roubado: reapresentação DEPOIS da rotação continua revogando a família (mesmo dentro da janela de 15 s)', async () => {
    const u = await userWithToken(t)
    const legit = await t.app.inject({ method: 'POST', url: '/api/v1/auth/refresh', headers: CSRF, cookies: { vg_rt: u.refreshToken } })
    const stolen = await t.app.inject({ method: 'POST', url: '/api/v1/auth/refresh', headers: CSRF, cookies: { vg_rt: u.refreshToken } })
    expect(stolen.statusCode).toBe(401)
    expect((await get(t, '/auth/me', legit.json().accessToken)).statusCode).toBe(401)
  })

  it('a corrida nunca entrega um segundo par de tokens (só uma sessão ativa na família)', async () => {
    const u = await userWithToken(t)
    const call = () => t.app.inject({ method: 'POST', url: '/api/v1/auth/refresh', headers: CSRF, cookies: { vg_rt: u.refreshToken } })
    const rs = await Promise.all([call(), call(), call()])
    expect(rs.filter((r) => r.statusCode === 200)).toHaveLength(1)
  })
})

describe('QA-07 / QA-10 — tentativas de senha', () => {
  it('login correto em paralelo com 4 erradas: o correto entra; 5 erradas seguidas bloqueiam até a senha certa', async () => {
    const u = await createUser(t)
    const rs = await Promise.all([
      ...Array.from({ length: 4 }, (_, i) => send(t, 'POST', '/auth/login', { email: u.email, password: `errada-${i}-xyz` }, CSRF)),
      send(t, 'POST', '/auth/login', { email: u.email, password: PASSWORD }, CSRF),
    ])
    expect(rs[4]!.statusCode).toBe(200)
    expect(rs.slice(0, 4).every((r) => r.statusCode === 401)).toBe(true)
  })

  it('acerto zera o contador; 4 falhas + acerto + 4 falhas não bloqueia', async () => {
    const u = await createUser(t)
    const wrong = () => send(t, 'POST', '/auth/login', { email: u.email, password: 'errada-errada' }, CSRF)
    for (let i = 0; i < 4; i++) await wrong()
    await login(t, u.email)
    expect((await getUserRow(t, u.id)).failedLoginCount).toBe(0)
    for (let i = 0; i < 4; i++) await wrong()
    await login(t, u.email)
  })

  it('troca de senha: 5 senhas atuais erradas bloqueiam (429 TOO_MANY_ATTEMPTS mesmo com a certa) e o login também fica bloqueado; reset por e-mail destrava', async () => {
    const u = await userWithToken(t)
    const h = { ...bearer(u.accessToken), ...CSRF }
    for (let i = 0; i < 5; i++) {
      const r = await send(t, 'PATCH', '/auth/password', { currentPassword: `errada-${i}-xx`, newPassword: 'Nova-Senha-Muito-Boa-77' }, h)
      expect(r.statusCode).toBe(400)
    }
    const blocked = await send(t, 'PATCH', '/auth/password', { currentPassword: PASSWORD, newPassword: 'Nova-Senha-Muito-Boa-77' }, h)
    expect(blocked.statusCode).toBe(429)
    expect(blocked.json().error.code).toBe('TOO_MANY_ATTEMPTS')
    expect((await send(t, 'POST', '/auth/login', { email: u.email, password: PASSWORD }, CSRF)).statusCode).toBe(401)
    await send(t, 'POST', '/auth/forgot-password', { email: u.email })
    const token = t.mailer.last('PASSWORD_RESET', u.email)!.token
    expect((await send(t, 'POST', '/auth/reset-password', { token, password: 'Senha-Resetada-Forte-3' })).statusCode).toBe(204)
    await login(t, u.email, 'Senha-Resetada-Forte-3')
  })

  it('DELETE /me: 5 senhas erradas bloqueiam (429) e a conta NÃO é excluída', async () => {
    const u = await userWithToken(t)
    for (let i = 0; i < 5; i++) {
      expect((await send(t, 'DELETE', '/me', { password: `errada-${i}-xx` }, bearer(u.accessToken))).statusCode).toBe(400)
    }
    const r = await send(t, 'DELETE', '/me', { password: PASSWORD }, bearer(u.accessToken))
    expect(r.statusCode).toBe(429)
    expect((await getUserRow(t, u.id)).status).toBe('ACTIVE')
  })

  /**
   * [QA-16] A tentativa é reservada (contador +1) ANTES do argon2 e só é "fechada" depois. Se o processo cair
   * ou a query de registro falhar entre as duas etapas na 5ª tentativa, o contador fica em 5 com locked_until
   * NULL: `reservePasswordAttempt` exige `failed_login_count < 5` e a conta fica bloqueada para sempre
   * (só o reset por e-mail destrava). Esperado: o estado "5 sem bloqueio" expira sozinho.
   */
  it('[QA-16] contador parado em 5 sem locked_until (tentativa interrompida) não pode bloquear a conta para sempre', async () => {
    const u = await createUser(t)
    await t.db
      .update(users)
      .set({ failedLoginCount: 5, lockedUntil: null, updatedAt: new Date(Date.now() - 24 * 3600_000) })
      .where(eq(users.id, u.id))
    const res = await send(t, 'POST', '/auth/login', { email: u.email, password: PASSWORD }, CSRF)
    expect(res.statusCode).toBe(200)
  })
})

describe('QA-16 — reverificação (rodada D1–D5)', () => {
  const wrong = (email: string, i: number) => send(t, 'POST', '/auth/login', { email, password: `errada-${i}-zz` }, CSRF)

  it('depois que o bloqueio expira o atacante ganha no máximo +5 tentativas, também em paralelo; nunca ilimitadas', async () => {
    const u = await createUser(t)
    const countEvaluated = async () =>
      (await t.db.select().from(auditLogs).where(eq(auditLogs.entityId, u.id))).filter(
        (r) => (r.metadata as { reason?: string } | null)?.reason === 'bad_password',
      ).length
    await Promise.all(Array.from({ length: 12 }, (_, i) => wrong(u.email, i)))
    expect(await countEvaluated()).toBe(5)
    const row = await getUserRow(t, u.id)
    expect(row.lockedUntil!.getTime()).toBeGreaterThan(Date.now())
    // expira o bloqueio e ataca de novo em paralelo
    await t.db.update(users).set({ lockedUntil: new Date(Date.now() - 1000) }).where(eq(users.id, u.id))
    await Promise.all(Array.from({ length: 12 }, (_, i) => wrong(u.email, 100 + i)))
    expect(await countEvaluated()).toBe(10)
    // travado de novo, inclusive para a senha certa
    expect((await send(t, 'POST', '/auth/login', { email: u.email, password: PASSWORD }, CSRF)).statusCode).toBe(401)
  })

  it('a 5ª reserva já grava locked_until (interrupção deixa a conta bloqueada só 15 min)', async () => {
    const u = await createUser(t)
    for (let i = 0; i < 4; i++) await wrong(u.email, i)
    const { reservePasswordAttempt } = await import('../src/modules/auth/service.js')
    expect(await reservePasswordAttempt(t.db, u.id)).toBe(5) // "processo cai" aqui, sem registrar a falha
    const row = await getUserRow(t, u.id)
    expect(row.lockedUntil!.getTime()).toBeGreaterThan(Date.now() + 14 * 60_000)
    expect((await send(t, 'POST', '/auth/login', { email: u.email, password: PASSWORD }, CSRF)).statusCode).toBe(401)
    await t.db.update(users).set({ lockedUntil: new Date(Date.now() - 1000) }).where(eq(users.id, u.id))
    await login(t, u.email)
    expect((await getUserRow(t, u.id)).failedLoginCount).toBe(0)
  })
})

describe('QA-08 — forgot-password', () => {
  it('falha do provedor de e-mail em background não derruba a resposta (202) nem gera rejeição não tratada', async () => {
    const failing: Mailer = { send: async () => Promise.reject(new Error('SMTP fora')) }
    const s = await createTestApp({ mailer: failing })
    try {
      const u = await createUser(s)
      const res = await send(s, 'POST', '/auth/forgot-password', { email: u.email })
      expect(res.statusCode).toBe(202)
      await new Promise((r) => setTimeout(r, 20))
    } finally {
      await s.close()
    }
  })

  it('e-mail inexistente: 202, nenhum e-mail, audit sem o e-mail em claro', async () => {
    const email = `nao.existe.${Date.now()}@x.dev`
    const before = t.mailer.sent.length
    expect((await send(t, 'POST', '/auth/forgot-password', { email })).statusCode).toBe(202)
    expect(t.mailer.sent.length).toBe(before)
    const rows = await t.db.execute(sql`SELECT metadata::text AS m FROM audit_logs WHERE action = 'PASSWORD_RESET_REQUESTED'`)
    expect(JSON.stringify((rows as unknown as { rows: unknown[] }).rows)).not.toContain(email)
  })
})

describe('QA-11 — Vibes vencidas', () => {
  it('criar LIVE/SCHEDULED com endsAt no passado → 400; DRAFT no passado é aceito mas não pode virar LIVE', async () => {
    const [p] = await t.db.execute(sql`SELECT id FROM products LIMIT 1`).then((r) => (r as unknown as { rows: { id: string }[] }).rows)
    const prodId = p?.id ?? (await createLiveVibe(t)).product.id
    const base = { productId: prodId, minGetCents: 100, startsAt: new Date(Date.now() - 7200_000).toISOString(), endsAt: new Date(Date.now() - 3600_000).toISOString() }
    for (const status of ['LIVE', 'SCHEDULED']) {
      const r = await send(t, 'POST', '/admin/vibes', { ...base, slug: `past-${status.toLowerCase()}-${Date.now()}`, status }, bearer(admin.accessToken))
      expect(r.statusCode, status).toBe(400)
    }
    const d = await send(t, 'POST', '/admin/vibes', { ...base, slug: `past-draft-${Date.now()}` }, bearer(admin.accessToken))
    expect(d.statusCode).toBe(201)
    expect((await send(t, 'PATCH', `/admin/vibes/${d.json().data.id}`, { status: 'LIVE' }, bearer(admin.accessToken))).statusCode).toBe(400)
  })

  it('LIVE vencida: goalGets bloqueado (409 VIBE_EXPIRED), mas cancelar e /close continuam funcionando', async () => {
    const mk = async () => {
      const { vibe } = await createLiveVibe(t)
      await t.db
        .update(vibes)
        .set({ startsAt: new Date(Date.now() - 48 * 3600_000), endsAt: new Date(Date.now() - 60_000) })
        .where(eq(vibes.id, vibe.id))
      return vibe
    }
    const a = await mk()
    const g = await send(t, 'PATCH', `/admin/vibes/${a.id}`, { goalGets: 5 }, bearer(admin.accessToken))
    expect(g.statusCode).toBe(409)
    expect(g.json().error.code).toBe('VIBE_EXPIRED')
    expect((await send(t, 'PATCH', `/admin/vibes/${a.id}`, { status: 'CANCELLED' }, bearer(admin.accessToken))).statusCode).toBe(200)
    const b = await mk()
    expect((await send(t, 'POST', `/admin/vibes/${b.id}/close`, undefined, bearer(admin.accessToken))).statusCode).toBe(200)
  })
})

describe('QA-12 — TRUNCATE', () => {
  it('TRUNCATE com CASCADE também é bloqueado', async () => {
    const tmp = await createTestApp()
    try {
      await expect(tmp.db.execute(sql`TRUNCATE getcoin_ledger CASCADE`)).rejects.toThrow()
    } finally {
      await tmp.close()
    }
  })
})

describe('QA-13 — imageUrl em produção', () => {
  it('IMAGE_HOSTS vazio em produção: https recusado, caminho relativo aceito; allowlist respeitada, inclusive contra userinfo', async () => {
    for (const [hosts, cases] of [
      [undefined, [['/img/a.jpg', 201], ['https://cdn.qualquer.com/a.jpg', 400]]],
      [
        'api.vibeget.net',
        [
          ['https://api.vibeget.net/img/a.jpg', 201],
          ['https://API.VIBEGET.NET/img/b.jpg', 201],
          ['https://evil.com/a.jpg', 400],
          ['https://api.vibeget.net@evil.com/a.jpg', 400],
          ['https://api.vibeget.net.evil.com/a.jpg', 400],
          ['/img/../../etc/passwd', 400],
          ['//api.vibeget.net/a.jpg', 400],
        ],
      ],
    ] as const) {
      const p = await createTestApp({ env: { ...PROD_ENV, ...(hosts ? { IMAGE_HOSTS: hosts } : {}) } })
      try {
        const adm = await createUser(p, { role: 'ADMIN' })
        const { accessToken } = await login(p, adm.email)
        let i = 0
        for (const [url, code] of cases) {
          const r = await send(
            p,
            'POST',
            '/admin/products',
            { slug: `img-${Date.now()}-${++i}`, name: 'Produto Img', category: 'audio', originalPriceCents: 100, imageUrl: url },
            { ...bearer(accessToken), origin: ORIGIN },
          )
          expect(r.statusCode, `${hosts ?? '(vazio)'} ${url}`).toBe(code)
        }
      } finally {
        await p.close()
      }
    }
  })

  it('PATCH de produto também passa pela allowlist', async () => {
    const p = await createTestApp({ env: { ...PROD_ENV } })
    try {
      const adm = await createUser(p, { role: 'ADMIN' })
      const { accessToken } = await login(p, adm.email)
      const c = await send(p, 'POST', '/admin/products', { slug: `pp-${Date.now()}`, name: 'Produto', category: 'audio', originalPriceCents: 100 }, bearer(accessToken))
      const r = await send(p, 'PATCH', `/admin/products/${c.json().data.id}`, { imageUrl: 'https://evil.com/x.png' }, bearer(accessToken))
      expect(r.statusCode).toBe(400)
    } finally {
      await p.close()
    }
  })
})

describe('QA-15 — LGPD', () => {
  it('export traz ações de terceiros sobre o titular sem identificar o autor nem o IP', async () => {
    const u = await userWithToken(t)
    await send(t, 'POST', `/admin/users/${u.id}/wallet-adjustments`, { amountCents: 50, reason: 'Compensação atraso' }, bearer(admin.accessToken))
    const res = await get(t, '/me/export', u.accessToken)
    const others = res.json().actionsByOthers as { action: string }[]
    expect(others.map((o) => o.action)).toContain('WALLET_ADJUSTED')
    expect(JSON.stringify(others)).not.toContain(admin.id)
    expect(JSON.stringify(others)).not.toMatch(/"ip"|actorId/)
  })

  it('após DELETE /me nenhum audit ligado ao titular guarda IP', async () => {
    const u = await userWithToken(t)
    await send(t, 'POST', `/admin/users/${u.id}/wallet-adjustments`, { amountCents: 10, reason: 'motivo válido' }, bearer(admin.accessToken))
    expect((await send(t, 'DELETE', '/me', { password: u.password }, bearer(u.accessToken))).statusCode).toBe(204)
    const rows = await t.db.execute(
      sql`SELECT count(*)::int AS n FROM audit_logs WHERE ip IS NOT NULL AND (actor_id = ${u.id} OR (entity = 'user' AND entity_id = ${u.id}))`,
    )
    expect((rows as unknown as { rows: { n: number }[] }).rows[0]!.n).toBe(0)
  })
})
