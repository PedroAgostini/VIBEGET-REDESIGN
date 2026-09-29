import type { FastifyInstance, LightMyRequestResponse } from 'fastify'
import { eq } from 'drizzle-orm'
import { buildApp } from '../src/app.js'
import { loadEnv, type Env } from '../src/config/env.js'
import { createDb, type Db } from '../src/db/client.js'
import { products, users, vibes, type Role } from '../src/db/schema.js'
import { hashPassword, referralCode } from '../src/lib/crypto.js'
import { MemoryMailer, type Mailer } from '../src/lib/mailer.js'
import { createWallet } from '../src/modules/wallet/service.js'

export const ORIGIN = 'http://localhost:5173'
/** Headers exigidos nas rotas com cookie (CSRF). */
export const CSRF = { 'x-requested-with': 'fetch', origin: ORIGIN } as const
export const PASSWORD = 'Tr0cad0r-de-Vibes!'

export interface TestContext {
  app: FastifyInstance
  db: Db
  env: Env
  mailer: MemoryMailer
  /** QA: fecha só o banco (para provocar erro 500 com a app de pé). */
  closeDb: () => Promise<void>
  close: () => Promise<void>
}

/** App completa com PGlite em memória + migrações aplicadas. Um banco por chamada. */
export async function createTestApp(
  opts: { rateLimit?: boolean; env?: Record<string, string>; mailer?: Mailer } = {},
): Promise<TestContext> {
  const handle = await createDb({ pgliteDataDir: null })
  await handle.migrate()
  const env = loadEnv({ NODE_ENV: 'test', CORS_ORIGINS: ORIGIN, ...opts.env })
  const mailer = new MemoryMailer()
  const app = await buildApp({
    db: handle.db,
    env,
    mailer: opts.mailer ?? mailer,
    logger: false,
    rateLimit: opts.rateLimit ?? false,
  })
  await app.ready()
  let closed = false
  return {
    app,
    db: handle.db,
    env,
    mailer,
    closeDb: async () => {
      closed = true
      await handle.close()
    },
    close: async () => {
      await app.close()
      if (!closed) await handle.close()
    },
  }
}

let cpfSeq = 100_000_000
/** Gera CPF válido e único por execução. */
export function nextCpf(): string {
  const base = String(cpfSeq++).padStart(9, '0').split('').map(Number)
  const dv = (nums: number[]) => {
    const len = nums.length
    const s = nums.reduce((acc, n, i) => acc + n * (len + 1 - i), 0)
    const r = (s * 10) % 11
    return r === 10 ? 0 : r
  }
  const d1 = dv(base)
  const d2 = dv([...base, d1])
  return [...base, d1, d2].join('')
}

let emailSeq = 0
export interface CreatedUser {
  id: string
  email: string
  password: string
}

/** Insere usuário direto no banco (mais rápido que /register e não esbarra em rate limit). */
export async function createUser(
  t: Pick<TestContext, 'db'>,
  o: {
    role?: Role
    verified?: boolean
    cpf?: string | null
    birthDate?: string | null
    name?: string
    status?: 'ACTIVE' | 'SUSPENDED'
  } = {},
): Promise<CreatedUser> {
  const email = `user${++emailSeq}.${Date.now()}@teste.vibeget.dev`
  const now = new Date()
  const [u] = await t.db
    .insert(users)
    .values({
      name: o.name ?? `Usuário Teste ${emailSeq}`,
      email,
      passwordHash: await hashPassword(PASSWORD),
      role: o.role ?? 'USER',
      status: o.status ?? 'ACTIVE',
      emailVerifiedAt: o.verified === false ? null : now,
      cpf: o.cpf === undefined ? nextCpf() : o.cpf,
      birthDate: o.birthDate === undefined ? '1990-05-10' : o.birthDate,
      referralCode: referralCode(),
      termsAcceptedAt: now,
      termsVersion: 'test',
    })
    .returning({ id: users.id })
  await createWallet(t.db, u!.id)
  return { id: u!.id, email, password: PASSWORD }
}

export function refreshCookieOf(res: LightMyRequestResponse): string | undefined {
  return res.cookies.find((c) => c.name === 'vg_rt')?.value
}

export async function login(t: Pick<TestContext, 'app'>, email: string, password = PASSWORD) {
  const res = await t.app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: CSRF, payload: { email, password } })
  if (res.statusCode !== 200) throw new Error(`login falhou: ${res.statusCode} ${res.body}`)
  const body = res.json() as { accessToken: string }
  return { accessToken: body.accessToken, refreshToken: refreshCookieOf(res)!, res }
}

/** Cria usuário e já devolve o access token. */
export async function userWithToken(t: TestContext, o: Parameters<typeof createUser>[1] = {}) {
  const user = await createUser(t, o)
  const { accessToken, refreshToken } = await login(t, user.email)
  return { ...user, accessToken, refreshToken }
}

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` })

/** Produto + Vibe LIVE aberta agora (min R$ 3,95, cashback 40%). */
export async function createLiveVibe(
  t: Pick<TestContext, 'db'>,
  o: { minGetCents?: number; cashbackPercent?: number; status?: 'LIVE' | 'DRAFT' | 'SCHEDULED' } = {},
) {
  const slug = `produto-teste-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  const [p] = await t.db
    .insert(products)
    .values({ slug, name: 'Produto Teste', category: 'smartphones', originalPriceCents: 500_000 })
    .returning()
  const [v] = await t.db
    .insert(vibes)
    .values({
      productId: p!.id,
      slug: `vibe-${slug}`,
      status: o.status ?? 'LIVE',
      minGetCents: o.minGetCents ?? 395,
      startsAt: new Date(Date.now() - 60 * 60 * 1000),
      endsAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      cashbackPercent: o.cashbackPercent ?? 40,
    })
    .returning()
  return { product: p!, vibe: v! }
}

export async function getUserRow(t: Pick<TestContext, 'db'>, id: string) {
  const [u] = await t.db.select().from(users).where(eq(users.id, id))
  return u!
}
