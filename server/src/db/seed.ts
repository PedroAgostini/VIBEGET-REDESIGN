import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { eq } from 'drizzle-orm'
import { loadEnv, type Env } from '../config/env.js'
import { SettingsStore } from '../lib/settings.js'
import { hashPassword, referralCode } from '../lib/crypto.js'
import { passwordSchema, emailSchema } from '../modules/auth/schemas.js'
import { createWallet } from '../modules/wallet/service.js'
import { createDb, type Db } from './client.js'
import { products, users, vibes } from './schema.js'

const DAY = 24 * 60 * 60 * 1000
const HOUR = 60 * 60 * 1000

/**
 * D5: produtos de DEMONSTRAÇÃO (fictícios; nomes vindos do src/data.js do front). Só com --demo. Preços em centavos.
 * Os 4 primeiros têm preço original publicado em data.js; os 4 últimos só aparecem no ticker
 * sem preço — os valores abaixo são ESTIMATIVAS a confirmar com o cliente.
 */
export const SEED_PRODUCTS = [
  { slug: 'iphone-15-pro-max-256gb', name: 'iPhone 15 Pro Max 256GB', category: 'smartphones', imageUrl: '/img/iphone.jpg', originalPriceCents: 9_999_00 },
  { slug: 'samsung-galaxy-s24-ultra', name: 'Samsung Galaxy S24 Ultra', category: 'smartphones', imageUrl: '/img/s24.jpg', originalPriceCents: 8_999_00 },
  { slug: 'google-pixel-8-pro', name: 'Google Pixel 8 Pro', category: 'smartphones', imageUrl: '/img/pixel.webp', originalPriceCents: 6_999_00 },
  { slug: 'asus-rog-zephyrus-g16', name: 'ASUS ROG Zephyrus G16', category: 'notebooks', imageUrl: '/img/rog.jpg', originalPriceCents: 14_999_00 },
  { slug: 'macbook-pro-m3-14', name: 'MacBook Pro M3 14"', category: 'notebooks', imageUrl: null, originalPriceCents: 16_999_00, estimated: true },
  { slug: 'xiaomi-14-pro', name: 'Xiaomi 14 Pro', category: 'smartphones', imageUrl: null, originalPriceCents: 6_499_00, estimated: true },
  { slug: 'dell-xps-15', name: 'Dell XPS 15', category: 'notebooks', imageUrl: null, originalPriceCents: 13_999_00, estimated: true },
  { slug: 'lenovo-thinkpad-x1-carbon', name: 'Lenovo ThinkPad X1 Carbon', category: 'notebooks', imageUrl: null, originalPriceCents: 12_999_00, estimated: true },
] as const

/** D10: marca, modelo e ficha técnica dos produtos de demonstração (características públicas de cada aparelho). */
export const DEMO_DETAILS: Record<string, { brand: string; model: string; specs: Array<{ label: string; value: string }> }> = {
  'iphone-15-pro-max-256gb': {
    brand: 'Apple', model: 'iPhone 15 Pro Max',
    specs: [
      { label: 'Armazenamento', value: '256 GB' }, { label: 'Tela', value: '6,7" Super Retina XDR' },
      { label: 'Chip', value: 'A17 Pro' }, { label: 'Câmera principal', value: '48 MP' }, { label: 'Conector', value: 'USB-C' },
    ],
  },
  'samsung-galaxy-s24-ultra': {
    brand: 'Samsung', model: 'Galaxy S24 Ultra',
    specs: [
      { label: 'Tela', value: '6,8" Dynamic AMOLED 2X' }, { label: 'Câmera principal', value: '200 MP' },
      { label: 'Caneta', value: 'S Pen integrada' }, { label: 'Conector', value: 'USB-C' },
    ],
  },
  'google-pixel-8-pro': {
    brand: 'Google', model: 'Pixel 8 Pro',
    specs: [{ label: 'Tela', value: '6,7" OLED' }, { label: 'Chip', value: 'Google Tensor G3' }, { label: 'Câmera principal', value: '50 MP' }],
  },
  'asus-rog-zephyrus-g16': {
    brand: 'ASUS', model: 'ROG Zephyrus G16',
    specs: [{ label: 'Tela', value: '16"' }, { label: 'Tipo', value: 'Notebook gamer' }],
  },
  'macbook-pro-m3-14': {
    brand: 'Apple', model: 'MacBook Pro 14"',
    specs: [{ label: 'Chip', value: 'Apple M3' }, { label: 'Tela', value: '14,2" Liquid Retina XDR' }],
  },
  'xiaomi-14-pro': { brand: 'Xiaomi', model: '14 Pro', specs: [{ label: 'Chip', value: 'Snapdragon 8 Gen 3' }] },
  'dell-xps-15': { brand: 'Dell', model: 'XPS 15', specs: [{ label: 'Tela', value: '15,6"' }] },
  'lenovo-thinkpad-x1-carbon': { brand: 'Lenovo', model: 'ThinkPad X1 Carbon', specs: [{ label: 'Tela', value: '14"' }] },
}

/** Vibes de exemplo: 4 LIVE (produtos com foto) e 4 SCHEDULED. Get mínimo R$ 3,95; cashback 40%. */
function seedVibes(now: number) {
  const live = [
    { product: 'iphone-15-pro-max-256gb', endsIn: 2 * DAY + 2 * HOUR, goal: 480 },
    { product: 'samsung-galaxy-s24-ultra', endsIn: 4 * DAY + 9 * HOUR, goal: 450 },
    { product: 'google-pixel-8-pro', endsIn: 6 * DAY + 3 * HOUR, goal: 350 },
    { product: 'asus-rog-zephyrus-g16', endsIn: 9 * DAY + 5 * HOUR, goal: 600 },
  ].map((v) => ({ ...v, status: 'LIVE' as const, startsAt: new Date(now - DAY), endsAt: new Date(now + v.endsIn) }))
  const scheduled = ['macbook-pro-m3-14', 'xiaomi-14-pro', 'dell-xps-15', 'lenovo-thinkpad-x1-carbon'].map((p, i) => ({
    product: p,
    goal: 400,
    status: 'SCHEDULED' as const,
    startsAt: new Date(now + (i + 1) * DAY),
    endsAt: new Date(now + (i + 8) * DAY),
  }))
  return [...live, ...scheduled]
}

export interface SeedOptions {
  adminEmail?: string | undefined
  adminPassword?: string | undefined
  /** D5: produtos e Vibes FICTÍCIOS de demonstração. Nunca em produção. */
  demo?: boolean
  /** Env para os valores iniciais das configurações (D3). Sem env, não grava settings. */
  env?: Env
}

export async function seed(db: Db, opts: SeedOptions) {
  const log: string[] = []
  if (opts.demo && opts.env?.isProduction) {
    throw new Error('seed --demo é recusado em produção (os produtos de demonstração são fictícios).')
  }

  // Admin (credenciais só por env; nada hardcoded)
  if (opts.adminEmail && opts.adminPassword) {
    const email = emailSchema.parse(opts.adminEmail)
    const pw = passwordSchema.safeParse(opts.adminPassword)
    if (!pw.success) throw new Error(`SEED_ADMIN_PASSWORD inválida: ${pw.error.issues.map((i) => i.message).join('; ')}`)
    const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email))
    if (existing) {
      log.push(`admin ${email} já existe (senha não alterada)`)
    } else {
      const now = new Date()
      const [admin] = await db
        .insert(users)
        .values({
          name: 'Administrador VibeGet',
          email,
          passwordHash: await hashPassword(pw.data),
          role: 'ADMIN',
          emailVerifiedAt: now,
          referralCode: referralCode(),
          termsAcceptedAt: now,
          termsVersion: 'seed',
        })
        .returning({ id: users.id })
      await createWallet(db, admin!.id)
      log.push(`admin ${email} criado`)
    }
  } else {
    log.push('SEED_ADMIN_EMAIL/SEED_ADMIN_PASSWORD não definidos: admin NÃO criado')
  }

  // Configurações iniciais (D3): só grava chaves ainda inexistentes; depois o ADMIN edita no dashboard.
  if (opts.env) {
    const n = await new SettingsStore(db, opts.env).seedDefaults()
    log.push(`${n} configurações iniciais gravadas`)
  }

  if (!opts.demo) {
    log.push('produtos/Vibes de demonstração NÃO criados (use --demo fora de produção)')
    return log
  }

  // DEMO: produtos (upsert por slug) — fictícios, só para demonstração (D5)
  const productIds = new Map<string, string>()
  for (const { estimated, ...p } of SEED_PRODUCTS.map((p) => ({ estimated: false, ...p }))) {
    const description = estimated
      ? 'Produto de demonstração (fictício). Preço estimado.'
      : 'Produto de demonstração (fictício).'
    const details = DEMO_DETAILS[p.slug] ?? { brand: null, model: null, specs: [] }
    const [row] = await db
      .insert(products)
      .values({ ...p, description, ...details })
      .onConflictDoUpdate({
        target: products.slug,
        set: { name: p.name, category: p.category, imageUrl: p.imageUrl, originalPriceCents: p.originalPriceCents, ...details },
      })
      .returning({ id: products.id })
    productIds.set(p.slug, row!.id)
  }
  log.push(`${productIds.size} produtos`)

  // Vibes (não sobrescreve Vibes existentes)
  let created = 0
  for (const v of seedVibes(Date.now())) {
    const r = await db
      .insert(vibes)
      .values({
        productId: productIds.get(v.product)!,
        slug: v.product,
        status: v.status,
        minGetCents: 395,
        startsAt: v.startsAt,
        endsAt: v.endsAt,
        goalGets: v.goal,
        cashbackPercent: 40,
      })
      .onConflictDoNothing({ target: vibes.slug })
      .returning({ id: vibes.id })
    created += r.length
  }
  log.push(`${created} Vibes criadas`)
  return log
}

async function main() {
  const env = loadEnv()
  const handle = await createDb({ databaseUrl: env.DATABASE_URL, pgliteDataDir: env.PGLITE_DATA_DIR })
  try {
    const demo = process.argv.includes('--demo')
    const log = await seed(handle.db, {
      adminEmail: env.SEED_ADMIN_EMAIL,
      adminPassword: env.SEED_ADMIN_PASSWORD,
      demo,
      env,
    })
    for (const l of log) console.info(`seed: ${l}`)
  } finally {
    await handle.close()
  }
}

// Executa só quando chamado diretamente (tsx src/db/seed.ts), não quando importado por testes.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
