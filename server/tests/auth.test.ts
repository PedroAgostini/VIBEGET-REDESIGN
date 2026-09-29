/**
 * QA — cadastro, login, lockout, verificação de e-mail, reset e troca de senha.
 */
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { auditLogs, authTokens, users } from '../src/db/schema.js'
import { sha256 } from '../src/lib/crypto.js'
import {
  bearer,
  createTestApp,
  createUser,
  CSRF,
  getUserRow,
  login,
  nextCpf,
  PASSWORD,
  refreshCookieOf,
  userWithToken,
  type TestContext,
} from './helpers.js'
import { get, send } from './qa-helpers.js'

let t: TestContext
beforeAll(async () => {
  t = await createTestApp()
})
afterAll(async () => {
  await t.close()
})

let seq = 0
const newEmail = () => `qa.auth.${Date.now()}.${++seq}@teste.vibeget.dev`
const validReg = (o: Record<string, unknown> = {}) => ({
  name: 'Ana Paula Lima',
  email: newEmail(),
  password: 'Correta-Cavalo-Bateria-9',
  acceptTerms: true,
  ...o,
})
const register = (payload: unknown, headers: Record<string, string> = CSRF) =>
  send(t, 'POST', '/auth/register', payload, headers)

describe('POST /auth/register', () => {
  it('cadastro válido: 201, usuário EXPLORADOR/USER, termos gravados, sem hash na resposta, e-mail de verificação enviado', async () => {
    const body = validReg({ cpf: nextCpf(), phone: '(11) 98888-7777', birthDate: '1990-01-01', marketingOptIn: true })
    const res = await register(body)
    expect(res.statusCode, res.body).toBe(201)
    const json = res.json()
    expect(json.accessToken).toEqual(expect.any(String))
    expect(json.expiresIn).toBe(900)
    expect(json.user).toMatchObject({ email: body.email, role: 'USER', level: 'EXPLORADOR', status: 'ACTIVE', emailVerified: false })
    expect(JSON.stringify(json)).not.toMatch(/passwordHash|argon2|refreshToken/)
    expect(json.user.cpfMasked).toMatch(/^\*\*\*\.\d{3}\.\d{3}-\*\*$/)
    expect(res.headers['cache-control']).toBe('no-store')
    const row = await getUserRow(t, json.user.id)
    expect(row.termsAcceptedAt).toBeInstanceOf(Date)
    expect(row.termsVersion).toBe(t.env.TERMS_VERSION)
    expect(row.passwordHash).toMatch(/^\$argon2id\$/)
    expect(row.phone).toBe('11988887777')
    expect(t.mailer.last('EMAIL_VERIFY', body.email)).toBeTruthy()
  })

  it('e-mail é normalizado (trim + minúsculas)', async () => {
    const email = newEmail()
    const res = await register(validReg({ email: `  ${email.toUpperCase()}  ` }))
    expect(res.statusCode, res.body).toBe(201)
    expect(res.json().user.email).toBe(email)
  })

  it.each([
    ['senha curta', { password: 'Ab1!' }],
    ['senha comum', { password: 'password123' }],
    ['senha comum pt-BR com sufixo', { password: 'flamengo123!!' }],
    ['senha de um caractere repetido', { password: 'zzzzzzzzzzzz' }],
    ['senha > 128', { password: 'A1-'.repeat(50) }],
    ['e-mail inválido', { email: 'nao-e-email' }],
    ['nome curto', { name: 'A' }],
    ['CPF inválido (DV)', { cpf: '123.456.789-00' }],
    ['CPF com dígitos repetidos', { cpf: '111.111.111-11' }],
    ['telefone inválido', { phone: '123' }],
    ['data de nascimento futura', { birthDate: '2999-01-01' }],
    ['data em formato errado', { birthDate: '01/01/1990' }],
    ['acceptTerms ausente', { acceptTerms: undefined }],
    ['acceptTerms false', { acceptTerms: false }],
    ['acceptTerms "true" (string)', { acceptTerms: 'true' }],
  ])('rejeita %s com 400 VALIDATION_ERROR', async (_label, override) => {
    const res = await register(validReg(override))
    expect(res.statusCode, res.body).toBe(400)
    expect(res.json().error.code).toBe('VALIDATION_ERROR')
  })

  it('senha igual ao e-mail é rejeitada', async () => {
    const email = `senhaigual${Date.now()}@teste.vibeget.dev`
    const res = await register(validReg({ email, password: email }))
    expect(res.statusCode).toBe(400)
  })

  it.each([
    ['role', { role: 'ADMIN' }],
    ['level', { level: 'VIBER' }],
    ['status', { status: 'ACTIVE' }],
    ['emailVerifiedAt', { emailVerifiedAt: new Date().toISOString() }],
    ['id', { id: '00000000-0000-4000-8000-000000000000' }],
    ['passwordHash', { passwordHash: 'x' }],
    ['referredById', { referredById: '00000000-0000-4000-8000-000000000000' }],
  ])('mass assignment: campo extra "%s" é rejeitado (400) e nenhum usuário é criado', async (_f, extra) => {
    const body = validReg(extra)
    const res = await register(body)
    expect(res.statusCode).toBe(400)
    const [u] = await t.db.select().from(users).where(eq(users.email, body.email as string))
    expect(u).toBeUndefined()
  })

  it('e-mail duplicado → 409 ACCOUNT_EXISTS; CPF duplicado → 409 com a MESMA mensagem', async () => {
    const cpf = nextCpf()
    const first = validReg({ cpf })
    expect((await register(first)).statusCode).toBe(201)
    const dupEmail = await register(validReg({ email: (first.email as string).toUpperCase() }))
    const dupCpf = await register(validReg({ cpf }))
    expect(dupEmail.statusCode).toBe(409)
    expect(dupCpf.statusCode).toBe(409)
    expect(dupEmail.json()).toEqual(dupCpf.json())
    expect(dupEmail.json().error.code).toBe('ACCOUNT_EXISTS')
  })

  it('referralCode inexistente → 400 INVALID_REFERRAL_CODE', async () => {
    const res = await register(validReg({ referralCode: 'ZZZZZZZZ' }))
    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe('INVALID_REFERRAL_CODE')
  })

  it('JSON malformado → 400 INVALID_JSON sem detalhes do parser', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      headers: { ...CSRF, 'content-type': 'application/json' },
      payload: '{"name": "x",',
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe('INVALID_JSON')
    expect(res.body).not.toMatch(/Unexpected|position|SyntaxError/)
  })
})

describe('bônus de boas-vindas e de indicação', () => {
  let t2: TestContext
  beforeAll(async () => {
    t2 = await createTestApp({ env: { WELCOME_BONUS_CENTS: '500', REFERRAL_BONUS_CENTS: '300' } })
  })
  afterAll(async () => {
    await t2.close()
  })

  it('WELCOME_BONUS vira lançamento no livro-razão; REFERRAL só é pago quando o indicado confirma o e-mail (uma vez)', async () => {
    const regA = await send(t2, 'POST', '/auth/register', validReg(), CSRF)
    expect(regA.statusCode).toBe(201)
    const a = regA.json()
    const walletA = await get(t2, '/me/wallet', a.accessToken)
    expect(walletA.json().balanceCents).toBe(500)
    expect(walletA.json().data[0]).toMatchObject({ type: 'WELCOME_BONUS', amountCents: 500 })

    const bBody = validReg({ referralCode: a.user.referralCode.toLowerCase() })
    const regB = await send(t2, 'POST', '/auth/register', bBody, CSRF)
    expect(regB.statusCode).toBe(201)
    expect((await get(t2, '/me/wallet', a.accessToken)).json().balanceCents).toBe(500)

    const token = t2.mailer.last('EMAIL_VERIFY', bBody.email as string)!.token
    expect((await send(t2, 'POST', '/auth/verify-email', { token })).statusCode).toBe(204)
    expect((await get(t2, '/me/wallet', a.accessToken)).json().balanceCents).toBe(800)
    // segundo uso do token não paga de novo
    expect((await send(t2, 'POST', '/auth/verify-email', { token })).statusCode).toBe(400)
    expect((await get(t2, '/me/wallet', a.accessToken)).json().balanceCents).toBe(800)
  })
})

describe('POST /auth/login', () => {
  it('sucesso: 200 + access token + cookie de refresh; audita LOGIN_SUCCEEDED', async () => {
    const u = await createUser(t)
    const { res } = await login(t, u.email)
    expect(res.json().user.id).toBe(u.id)
    expect(refreshCookieOf(res)).toBeTruthy()
    const logs = await t.db.select().from(auditLogs).where(eq(auditLogs.entityId, u.id))
    expect(logs.map((l) => l.action)).toContain('LOGIN_SUCCEEDED')
  })

  it('não enumera: e-mail inexistente e senha errada devolvem status e corpo idênticos', async () => {
    const u = await createUser(t)
    const wrong = await send(t, 'POST', '/auth/login', { email: u.email, password: 'Errada-Errada-1' }, CSRF)
    const ghost = await send(t, 'POST', '/auth/login', { email: `ghost${Date.now()}@x.dev`, password: 'Errada-Errada-1' }, CSRF)
    expect(wrong.statusCode).toBe(401)
    expect(ghost.statusCode).toBe(401)
    expect(wrong.json()).toEqual(ghost.json())
    expect(wrong.json().error.code).toBe('INVALID_CREDENTIALS')
    expect(wrong.cookies.find((c) => c.name === 'vg_rt')).toBeUndefined()
  })

  it('audit de falha com e-mail inexistente não guarda o e-mail em claro', async () => {
    const email = `naoexiste.${Date.now()}@x.dev`
    await send(t, 'POST', '/auth/login', { email, password: 'qualquer-coisa-1' }, CSRF)
    const rows = await t.db.execute(sql`SELECT metadata::text AS m FROM audit_logs WHERE action = 'LOGIN_FAILED'`)
    const all = JSON.stringify((rows as unknown as { rows: unknown[] }).rows)
    expect(all).not.toContain(email)
  })

  it('lockout: após 5 falhas a conta fica bloqueada 15 min (nem a senha certa entra), sem revelar o bloqueio por status', async () => {
    const u = await createUser(t)
    for (let i = 0; i < 5; i++) {
      const r = await send(t, 'POST', '/auth/login', { email: u.email, password: `errada-${i}-xxxx` }, CSRF)
      expect(r.statusCode).toBe(401)
    }
    const row = await getUserRow(t, u.id)
    expect(row.lockedUntil!.getTime()).toBeGreaterThan(Date.now() + 14 * 60_000)
    expect(row.lockedUntil!.getTime()).toBeLessThanOrEqual(Date.now() + 15 * 60_000 + 5_000)
    const blocked = await send(t, 'POST', '/auth/login', { email: u.email, password: PASSWORD }, CSRF)
    expect(blocked.statusCode).toBe(401)
    expect(blocked.json().error.code).toBe('INVALID_CREDENTIALS')

    // bloqueio expirado → entra e zera o contador
    await t.db.update(users).set({ lockedUntil: new Date(Date.now() - 1000) }).where(eq(users.id, u.id))
    await login(t, u.email)
    const after = await getUserRow(t, u.id)
    expect(after.failedLoginCount).toBe(0)
    expect(after.lockedUntil).toBeNull()
  })

  /**
   * [QA-07] O bloqueio é lido ANTES da verificação argon2 e gravado depois: tentativas paralelas leem a conta
   * ainda desbloqueada e todas testam a senha. Esperado: no máximo 5 senhas avaliadas por janela de bloqueio.
   */
  it('[QA-07] 20 tentativas paralelas não podem testar mais de 5 senhas antes do bloqueio', async () => {
    const u = await createUser(t)
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => send(t, 'POST', '/auth/login', { email: u.email, password: `paralela-${i}-xx` }, CSRF)),
    )
    const rows = await t.db.select().from(auditLogs).where(eq(auditLogs.entityId, u.id))
    const evaluated = rows.filter((r) => (r.metadata as { reason?: string } | null)?.reason === 'bad_password').length
    expect(evaluated).toBeLessThanOrEqual(5)
  })

  it('4 falhas + sucesso zera o contador (não acumula entre logins válidos)', async () => {
    const u = await createUser(t)
    for (let i = 0; i < 4; i++) await send(t, 'POST', '/auth/login', { email: u.email, password: 'errada-xxxxx' }, CSRF)
    expect((await getUserRow(t, u.id)).failedLoginCount).toBe(4)
    await login(t, u.email)
    expect((await getUserRow(t, u.id)).failedLoginCount).toBe(0)
  })

  it('conta SUSPENSA: com senha certa → 403 ACCOUNT_SUSPENDED; com senha errada → 401 genérico', async () => {
    const u = await createUser(t, { status: 'SUSPENDED' })
    const ok = await send(t, 'POST', '/auth/login', { email: u.email, password: PASSWORD }, CSRF)
    expect(ok.statusCode).toBe(403)
    expect(ok.json().error.code).toBe('ACCOUNT_SUSPENDED')
    const bad = await send(t, 'POST', '/auth/login', { email: u.email, password: 'errada-xxxxx' }, CSRF)
    expect(bad.statusCode).toBe(401)
  })

  it('campo extra no login é rejeitado (400)', async () => {
    const res = await send(t, 'POST', '/auth/login', { email: 'a@b.com', password: 'x', role: 'ADMIN' }, CSRF)
    expect(res.statusCode).toBe(400)
  })
})

describe('verificação de e-mail', () => {
  it('token é de uso único; token inválido → 400', async () => {
    const reg = await register(validReg())
    const email = reg.json().user.email
    const token = t.mailer.last('EMAIL_VERIFY', email)!.token
    expect((await send(t, 'POST', '/auth/verify-email', { token })).statusCode).toBe(204)
    const again = await send(t, 'POST', '/auth/verify-email', { token })
    expect(again.statusCode).toBe(400)
    expect(again.json().error.code).toBe('INVALID_TOKEN')
    expect((await send(t, 'POST', '/auth/verify-email', { token: 'x'.repeat(43) })).statusCode).toBe(400)
  })

  it('token expirado → 400 e o e-mail continua não verificado', async () => {
    const reg = await register(validReg())
    const { user } = reg.json()
    const token = t.mailer.last('EMAIL_VERIFY', user.email)!.token
    await t.db.update(authTokens).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(authTokens.tokenHash, sha256(token)))
    expect((await send(t, 'POST', '/auth/verify-email', { token })).statusCode).toBe(400)
    expect((await getUserRow(t, user.id)).emailVerifiedAt).toBeNull()
  })

  it('token de PASSWORD_RESET não serve para verificar e-mail', async () => {
    const u = await createUser(t, { verified: false })
    await send(t, 'POST', '/auth/forgot-password', { email: u.email })
    const token = t.mailer.last('PASSWORD_RESET', u.email)!.token
    expect((await send(t, 'POST', '/auth/verify-email', { token })).statusCode).toBe(400)
  })

  it('resend-verification exige login, invalida o link anterior e recusa se já verificado', async () => {
    expect((await send(t, 'POST', '/auth/resend-verification')).statusCode).toBe(401)
    const reg = await register(validReg())
    const { user, accessToken } = reg.json()
    const old = t.mailer.last('EMAIL_VERIFY', user.email)!.token
    const r = await send(t, 'POST', '/auth/resend-verification', undefined, bearer(accessToken))
    expect(r.statusCode).toBe(202)
    const fresh = t.mailer.last('EMAIL_VERIFY', user.email)!.token
    expect(fresh).not.toBe(old)
    expect((await send(t, 'POST', '/auth/verify-email', { token: old })).statusCode).toBe(400)
    expect((await send(t, 'POST', '/auth/verify-email', { token: fresh })).statusCode).toBe(204)
    const again = await send(t, 'POST', '/auth/resend-verification', undefined, bearer(accessToken))
    expect(again.statusCode).toBe(409)
  })
})

describe('forgot/reset password', () => {
  it('forgot responde 202 com a mesma mensagem para e-mail existente e inexistente; só envia para o existente', async () => {
    const u = await createUser(t)
    const before = t.mailer.sent.length
    const a = await send(t, 'POST', '/auth/forgot-password', { email: u.email })
    const b = await send(t, 'POST', '/auth/forgot-password', { email: `ghost.${Date.now()}@x.dev` })
    expect(a.statusCode).toBe(202)
    expect(b.statusCode).toBe(202)
    expect(a.json()).toEqual(b.json())
    expect(t.mailer.sent.length).toBe(before + 1)
  })

  it('forgot para conta SUSPENSA não envia e-mail', async () => {
    const u = await createUser(t, { status: 'SUSPENDED' })
    await send(t, 'POST', '/auth/forgot-password', { email: u.email })
    expect(t.mailer.last('PASSWORD_RESET', u.email)).toBeUndefined()
  })

  it('reset: troca a senha, revoga TODAS as sessões (access e refresh), token de uso único, zera lockout', async () => {
    const u = await userWithToken(t)
    await t.db.update(users).set({ failedLoginCount: 3 }).where(eq(users.id, u.id))
    await send(t, 'POST', '/auth/forgot-password', { email: u.email })
    const token = t.mailer.last('PASSWORD_RESET', u.email)!.token
    const newPassword = 'Nova-Senha-Muito-Boa-77'
    const res = await send(t, 'POST', '/auth/reset-password', { token, password: newPassword })
    expect(res.statusCode).toBe(204)

    expect((await get(t, '/auth/me', u.accessToken)).statusCode).toBe(401)
    const r = await send(t, 'POST', '/auth/refresh', undefined, CSRF)
    expect(r.statusCode).toBe(401)
    const refreshOld = await t.app.inject({ method: 'POST', url: '/api/v1/auth/refresh', headers: CSRF, cookies: { vg_rt: u.refreshToken } })
    expect(refreshOld.statusCode).toBe(401)

    expect((await send(t, 'POST', '/auth/login', { email: u.email, password: PASSWORD }, CSRF)).statusCode).toBe(401)
    await login(t, u.email, newPassword)
    expect((await getUserRow(t, u.id)).failedLoginCount).toBe(0)

    const reuse = await send(t, 'POST', '/auth/reset-password', { token, password: 'Outra-Senha-Boa-88' })
    expect(reuse.statusCode).toBe(400)
  })

  it('reset com token expirado → 400 e senha inalterada', async () => {
    const u = await createUser(t)
    await send(t, 'POST', '/auth/forgot-password', { email: u.email })
    const token = t.mailer.last('PASSWORD_RESET', u.email)!.token
    await t.db.update(authTokens).set({ expiresAt: new Date(Date.now() - 1) }).where(eq(authTokens.tokenHash, sha256(token)))
    expect((await send(t, 'POST', '/auth/reset-password', { token, password: 'Nova-Senha-Muito-Boa-77' })).statusCode).toBe(400)
    await login(t, u.email)
  })

  it('reset exige senha forte', async () => {
    const u = await createUser(t)
    await send(t, 'POST', '/auth/forgot-password', { email: u.email })
    const token = t.mailer.last('PASSWORD_RESET', u.email)!.token
    expect((await send(t, 'POST', '/auth/reset-password', { token, password: 'senha123' })).statusCode).toBe(400)
  })

  it('pedir um novo reset invalida o link anterior', async () => {
    const u = await createUser(t)
    await send(t, 'POST', '/auth/forgot-password', { email: u.email })
    const first = t.mailer.last('PASSWORD_RESET', u.email)!.token
    await send(t, 'POST', '/auth/forgot-password', { email: u.email })
    expect((await send(t, 'POST', '/auth/reset-password', { token: first, password: 'Nova-Senha-Muito-Boa-77' })).statusCode).toBe(400)
  })
})

describe('PATCH /auth/password', () => {
  it('exige a senha atual (400 INVALID_PASSWORD) e não altera nada se errada', async () => {
    const u = await userWithToken(t)
    const res = await send(t, 'PATCH', '/auth/password', { currentPassword: 'errada-errada', newPassword: 'Nova-Senha-Muito-Boa-77' }, { ...bearer(u.accessToken), ...CSRF })
    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe('INVALID_PASSWORD')
    expect((await get(t, '/auth/me', u.accessToken)).statusCode).toBe(200)
  })

  it('sucesso: nova sessão devolvida, sessões antigas revogadas, senha antiga não entra', async () => {
    const u = await userWithToken(t)
    const other = await login(t, u.email) // "outro dispositivo"
    const res = await send(t, 'PATCH', '/auth/password', { currentPassword: PASSWORD, newPassword: 'Nova-Senha-Muito-Boa-77' }, { ...bearer(u.accessToken), ...CSRF })
    expect(res.statusCode, res.body).toBe(200)
    const fresh = res.json().accessToken
    expect(refreshCookieOf(res)).toBeTruthy()
    expect((await get(t, '/auth/me', u.accessToken)).statusCode).toBe(401)
    expect((await get(t, '/auth/me', other.accessToken)).statusCode).toBe(401)
    expect((await get(t, '/auth/me', fresh)).statusCode).toBe(200)
    expect((await send(t, 'POST', '/auth/login', { email: u.email, password: PASSWORD }, CSRF)).statusCode).toBe(401)
  })

  it('nova senha igual à atual, comum ou igual ao e-mail é recusada', async () => {
    const u = await userWithToken(t)
    const h = { ...bearer(u.accessToken), ...CSRF }
    expect((await send(t, 'PATCH', '/auth/password', { currentPassword: PASSWORD, newPassword: PASSWORD }, h)).statusCode).toBe(400)
    expect((await send(t, 'PATCH', '/auth/password', { currentPassword: PASSWORD, newPassword: 'password123' }, h)).statusCode).toBe(400)
    expect((await send(t, 'PATCH', '/auth/password', { currentPassword: PASSWORD, newPassword: u.email }, h)).statusCode).toBe(400)
  })

  it('exige CSRF (sem X-Requested-With → 403)', async () => {
    const u = await userWithToken(t)
    const res = await send(t, 'PATCH', '/auth/password', { currentPassword: PASSWORD, newPassword: 'Nova-Senha-Muito-Boa-77' }, bearer(u.accessToken))
    expect(res.statusCode).toBe(403)
  })
})
