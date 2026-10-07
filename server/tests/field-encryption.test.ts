import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { encryptLegacyData } from '../src/db/encrypt-legacy.js'
import { applyCashMovement } from '../src/modules/cash/service.js'
import { configureFieldCrypto, decryptField, encryptField, emailIndex } from '../src/lib/field-crypto.js'
import { bearer, createTestApp, CSRF, nextCpf, PASSWORD, type TestContext } from './helpers.js'
import { DATA_KEYS } from './qa-helpers.js'

/**
 * Criptografia dos dados pessoais no banco (LGPD). O que se verifica aqui é o que um vazamento
 * do banco ou de um backup exporia: lendo as tabelas em SQL puro, nenhum dado pessoal aparece.
 */

let t: TestContext
const rows = async (q: ReturnType<typeof sql>) => ((await t.db.execute(q)) as unknown as { rows: Record<string, unknown>[] }).rows

const person = {
  name: 'Maria Cifrada',
  email: 'maria.cifrada@exemplo.com.br',
  cpf: nextCpf(),
  phone: '11987654321',
  birthDate: '1991-03-15',
}
let token = ''
let userId = ''

beforeAll(async () => {
  t = await createTestApp()
  const reg = await t.app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    headers: { ...CSRF, 'user-agent': 'NavegadorDeTeste/1.0' },
    payload: { ...person, password: PASSWORD, acceptTerms: true },
  })
  expect(reg.statusCode, reg.body).toBe(201)
  token = reg.json().accessToken
  userId = reg.json().user.id
  const api = (method: 'PUT' | 'POST', url: string, payload: object, headers: Record<string, string> = {}) =>
    t.app.inject({ method, url: `/api/v1${url}`, headers: { ...bearer(token), ...headers }, payload })
  const addr = await api('PUT', '/me/address', { cep: '01310100', street: 'Avenida Paulista', number: '1578', district: 'Bela Vista', city: 'São Paulo', state: 'SP' })
  expect(addr.statusCode, addr.body).toBe(200)
  await t.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${userId}`)
  await t.db.transaction((tx) => applyCashMovement(tx, { userId, amountCents: 5000, type: 'ADJUSTMENT', reason: 'teste' }))
  const w = await api('POST', '/me/withdrawals', { amountCents: 2000, pixKeyType: 'EMAIL', pixKey: 'pix.secreto@exemplo.com.br' }, { 'idempotency-key': 'cripto-saque-01' })
  expect(w.statusCode, w.body).toBe(201)
})
afterAll(async () => {
  await t.close()
})

describe('dados pessoais cifrados no banco', () => {
  it('em SQL puro (o que um vazamento exporia) nenhum dado pessoal aparece', async () => {
    const dump = JSON.stringify([
      ...(await rows(sql`SELECT * FROM users WHERE id = ${userId}`)),
      ...(await rows(sql`SELECT * FROM sessions WHERE user_id = ${userId}`)),
      ...(await rows(sql`SELECT * FROM withdrawals WHERE user_id = ${userId}`)),
      ...(await rows(sql`SELECT ip FROM audit_logs WHERE actor_id = ${userId}`)),
    ])
    for (const secret of [person.email, person.cpf, person.phone, person.birthDate, 'Avenida Paulista', '01310100', 'Bela Vista', 'pix.secreto', 'NavegadorDeTeste', '127.0.0.1']) {
      expect(dump, `vazou "${secret}"`).not.toContain(secret)
    }
    const [u] = await rows(sql`SELECT email, cpf, phone, birth_date, street, email_hash, cpf_hash FROM users WHERE id = ${userId}`)
    for (const c of ['email', 'cpf', 'phone', 'birth_date', 'street']) expect(String(u![c])).toMatch(/^enc:v1:[A-Za-z0-9_-]{30,}$/)
    expect(u!.email_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(u!.cpf_hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('o mesmo valor cifrado duas vezes gera cifras diferentes (sem padrão para comparar)', () => {
    expect(encryptField(person.cpf)).not.toBe(encryptField(person.cpf))
    expect(decryptField(encryptField(person.cpf))).toBe(person.cpf)
  })

  it('a API devolve os dados certos ao dono (cifra transparente)', async () => {
    const me = (await t.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: bearer(token) })).json().user
    expect(me).toMatchObject({ email: person.email, phone: person.phone, birthDate: person.birthDate, hasCpf: true })
    expect(me.address).toMatchObject({ street: 'Avenida Paulista', cep: '01310100', city: 'São Paulo' })
  })

  it('login, cadastro duplicado (e-mail e CPF) e busca do admin funcionam pelo índice cego', async () => {
    const login = await t.app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: CSRF, payload: { email: person.email.toUpperCase(), password: PASSWORD } })
    expect(login.statusCode, login.body).toBe(200)
    for (const dup of [{ email: person.email, cpf: nextCpf() }, { email: 'outra@exemplo.com.br', cpf: person.cpf }]) {
      const r = await t.app.inject({ method: 'POST', url: '/api/v1/auth/register', headers: CSRF, payload: { ...person, ...dup, password: PASSWORD, acceptTerms: true } })
      expect(r.json().error.code).toBe('ACCOUNT_EXISTS')
    }
    const [u] = await rows(sql`SELECT email_hash FROM users WHERE id = ${userId}`)
    expect(u!.email_hash).toBe(emailIndex(person.email))
  })

  it('cifra adulterada no banco é detectada (falha ao ler, nunca devolve dado trocado)', () => {
    const enc = encryptField('11999990000')
    const tampered = `${enc.slice(0, -4)}${enc.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA'}`
    expect(() => decryptField(tampered)).toThrow()
    expect(() => decryptField(enc.replace('enc:v1:', 'enc:v9:'))).toThrow(/indisponível/)
  })
})

describe('migração e troca de chave', () => {
  it('dado antigo em texto puro é cifrado pela migração (e o hash é preenchido)', async () => {
    await t.db.execute(sql`UPDATE users SET phone = '11911112222' WHERE id = ${userId}`)
    await t.db.execute(sql`UPDATE withdrawals SET pix_key = 'legado@exemplo.com.br' WHERE user_id = ${userId}`)
    const { updated } = await encryptLegacyData(t.db)
    expect(updated).toBeGreaterThanOrEqual(2)
    const [u] = await rows(sql`SELECT phone FROM users WHERE id = ${userId}`)
    expect(String(u!.phone)).toMatch(/^enc:v1:/)
    const me = (await t.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: bearer(token) })).json().user
    expect(me.phone).toBe('11911112222')
    expect((await encryptLegacyData(t.db)).updated).toBe(0) // idempotente
  })

  it('troca de chave: a nova cifra tudo de novo e a antiga continua decifrando até lá', async () => {
    configureFieldCrypto({ key: 'nova-chave-de-dados-para-o-teste-de-rotacao-0001', keyId: 'v2', previous: { v1: DATA_KEYS.DATA_KEY }, indexKey: DATA_KEYS.DATA_INDEX_KEY })
    const before = (await t.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: bearer(token) })).json().user
    expect(before.email).toBe(person.email) // v1 ainda lido com a chave antiga
    expect((await encryptLegacyData(t.db)).updated).toBeGreaterThan(0)
    const [u] = await rows(sql`SELECT email, cpf FROM users WHERE id = ${userId}`)
    expect(String(u!.email)).toMatch(/^enc:v2:/)
    const after = (await t.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: bearer(token) })).json().user
    expect(after).toMatchObject({ email: person.email, phone: '11911112222' })
    // índice cego não muda na troca: o login continua funcionando
    const login = await t.app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: CSRF, payload: { email: person.email, password: PASSWORD } })
    expect(login.statusCode).toBe(200)
  })
})
