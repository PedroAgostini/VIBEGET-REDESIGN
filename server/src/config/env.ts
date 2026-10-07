import { randomBytes } from 'node:crypto'
import { z } from 'zod'

// Segredos fixos de desenvolvimento: SÓ usados com NODE_ENV=development|test explícito.
const DEV_JWT_SECRET = 'dev-only-insecure-jwt-secret-change-me-0123456789'
const DEV_WEBHOOK_SECRET = 'dev-only-insecure-webhook-secret-change-me-012345'
const DEV_DATA_KEY = 'dev-only-insecure-data-key-change-me-0123456789abcdef'
const DEV_DATA_INDEX_KEY = 'dev-only-insecure-index-key-change-me-0123456789abcd'

/** "id:segredo,id:segredo" → { id: segredo } (chaves antigas, só para decifrar). */
const keyList = z
  .string()
  .optional()
  .transform((v, ctx) => {
    const out: Record<string, string> = {}
    for (const item of (v ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
      const i = item.indexOf(':')
      const id = item.slice(0, i)
      const secret = item.slice(i + 1)
      if (i < 1 || !/^[a-z0-9]{1,16}$/i.test(id) || secret.length < 32) {
        ctx.addIssue({ code: 'custom', message: 'use id:segredo (segredo com 32+ caracteres), separados por vírgula' })
        return z.NEVER
      }
      out[id] = secret
    }
    return out
  })

const bool = (def: boolean) =>
  z
    .enum(['true', 'false', '1', '0'])
    .optional()
    .transform((v) => (v === undefined ? def : v === 'true' || v === '1'))

const emptyToUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v)

const csv = (def: string) =>
  z
    .string()
    .default(def)
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    )

/**
 * TRUST_PROXY (repassado ao Fastify `trustProxy`):
 * - `false` (padrão): ignora X-Forwarded-For; req.ip = IP da conexão.
 * - `true`: confia em qualquer proxy (só se o proxy SOBRESCREVE X-Forwarded-For).
 * - número N: confia nos N saltos mais próximos (ex.: 1 = um load balancer).
 * - lista de IPs/CIDRs separados por vírgula: confia só nesses proxies (recomendado).
 */
const trustProxySchema = z
  .string()
  .optional()
  .transform((v, ctx): boolean | number | string[] => {
    if (v === undefined || v.trim() === '' || v === 'false' || v === '0') return false
    if (v === 'true') return true
    if (/^\d+$/.test(v)) return Number(v)
    const list = v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    if (list.every((s) => /^[0-9a-fA-F:.]+(\/\d{1,3})?$/.test(s) || ['loopback', 'linklocal', 'uniquelocal'].includes(s))) {
      return list
    }
    ctx.addIssue({ code: 'custom', message: 'use false, true, número de saltos ou lista de IPs/CIDRs' })
    return z.NEVER
  })

const envSchema = z
  .object({
    // Sem NODE_ENV explícito o app se comporta como PRODUÇÃO (fail-closed).
    NODE_ENV: z.enum(['development', 'test', 'production']).optional(),
    HOST: z.string().default('127.0.0.1'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3333),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    TRUST_PROXY: trustProxySchema,

    DATABASE_URL: z.preprocess(emptyToUndefined, z.string().url().optional()),
    PGLITE_DATA_DIR: z.string().default('./.data/pglite'),
    AUTO_MIGRATE: bool(true),

    JWT_SECRET: z.preprocess(emptyToUndefined, z.string().min(16).optional()),
    ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
    // Janela em que um refresh recém-rotacionado reapresentado é tratado como corrida (não como roubo).
    REFRESH_REUSE_GRACE_SECONDS: z.coerce.number().int().min(0).max(60).default(15),
    COOKIE_SECURE: bool(true),

    CORS_ORIGINS: csv('http://localhost:5173,http://127.0.0.1:5173'),
    APP_URL: z.string().url().default('http://localhost:5173'),
    // Hosts aceitos em imageUrl https:// de produtos (além de caminhos relativos "/...").
    // Vazio: em development/test qualquer host https; em produção NENHUM (só caminhos relativos).
    IMAGE_HOSTS: csv(''),

    // D3: valores INICIAIS das configurações (tabela settings). Depois do seed, o ADMIN edita em /admin/settings.
    // Enquanto uma chave não existe na tabela, vale o valor daqui.
    WELCOME_BONUS_CENTS: z.coerce.number().int().min(0).default(0),
    REFERRAL_BONUS_CENTS: z.coerce.number().int().min(0).default(0),
    GET_CUTOFF_SECONDS: z.coerce.number().int().min(0).max(3600).default(60),
    PAYMENT_GRACE_SECONDS: z.coerce.number().int().min(0).max(3600).default(40),
    DEFAULT_CASHBACK_PERCENT: z.coerce.number().int().min(0).max(100).default(40),
    // D6: valores iniciais do saque (centavos): mínimo R$ 10,00 e máximo diário R$ 5.000,00
    WITHDRAW_MIN_CENTS: z.coerce.number().int().min(1).max(10_000_000).default(1_000),
    WITHDRAW_DAILY_MAX_CENTS: z.coerce.number().int().min(1).max(100_000_000).default(500_000),
    // D11/D12: valores iniciais (ADMIN edita em /admin/settings/getcoin e /admin/settings/market)
    GETCOIN_UNIT_PRICE_CENTS: z.coerce.number().int().min(1).max(100_000).default(100),
    GETCOIN_CUSTOM_MIN_CENTS: z.coerce.number().int().min(100).max(100_000_000).refine((v) => v % 100 === 0).default(1_000),
    GETCOIN_CUSTOM_MAX_CENTS: z.coerce.number().int().min(100).max(100_000_000).refine((v) => v % 100 === 0).default(100_000),
    GETCOIN_CUSTOM_ENABLED: bool(true),
    MARKET_FEE_PERCENT: z.coerce.number().int().min(0).max(50).default(10),
    MARKET_MIN_UNIT_PRICE_CENTS: z.coerce.number().int().min(1).max(100_000).default(10),
    MARKET_MAX_UNIT_PRICE_CENTS: z.coerce.number().int().min(1).max(100_000).default(1_000),
    MARKET_MIN_LISTING_CENTS: z.coerce.number().int().min(100).max(100_000_000).refine((v) => v % 100 === 0).default(1_000),
    MARKET_ENABLED: bool(true),
    MARKET_MAX_PENDING_ORDERS: z.coerce.number().int().min(1).max(20).default(2),
    MARKET_ORDER_TTL_MINUTES: z.coerce.number().int().min(1).max(60).default(10),

    // D5: upload de imagens (servidas em /uploads)
    UPLOAD_DIR: z.string().default('./uploads'),
    UPLOAD_MAX_BYTES: z.coerce.number().int().min(10_000).max(20_000_000).default(5_000_000),
    TERMS_VERSION: z.string().min(1).default('2026-09'),

    PAYMENT_WEBHOOK_SECRET: z.preprocess(emptyToUndefined, z.string().min(16).optional()),

    // LGPD: criptografia dos dados pessoais no banco (ver src/lib/field-crypto.ts).
    DATA_KEY: z.preprocess(emptyToUndefined, z.string().min(32).optional()),
    DATA_KEY_ID: z.string().regex(/^[a-z0-9]{1,16}$/i).default('v1'),
    DATA_KEYS_OLD: keyList,
    DATA_INDEX_KEY: z.preprocess(emptyToUndefined, z.string().min(32).optional()),
    // LGPD (QA-15): por quanto tempo guardar IP na auditoria e sessões/links de e-mail encerrados.
    AUDIT_IP_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(180),
    SESSION_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(30),
    PAYMENT_TTL_MINUTES: z.coerce.number().int().min(1).max(1440).default(30),
    JOBS_INTERVAL_MS: z.coerce.number().int().min(0).default(60_000),

    SEED_ADMIN_EMAIL: z.preprocess(emptyToUndefined, z.string().email().optional()),
    SEED_ADMIN_PASSWORD: z.preprocess(emptyToUndefined, z.string().optional()),
  })
  .superRefine((env, ctx) => {
    const devLike = env.NODE_ENV === 'development' || env.NODE_ENV === 'test'
    if (devLike) return
    const where = env.NODE_ENV === 'production' ? 'em produção' : 'sem NODE_ENV (tratado como produção)'
    if (!env.DATABASE_URL) {
      ctx.addIssue({ code: 'custom', path: ['DATABASE_URL'], message: `obrigatório ${where}` })
    }
    if (!env.COOKIE_SECURE) {
      ctx.addIssue({ code: 'custom', path: ['COOKIE_SECURE'], message: `deve ser true ${where}` })
    }
    // Produção explícita: segredos fortes obrigatórios.
    // Sem NODE_ENV: segredos ausentes viram aleatórios efêmeros (ver transform), mas se informados precisam ser fortes.
    const explicitProd = env.NODE_ENV === 'production'
    if ((explicitProd && !env.JWT_SECRET) || (env.JWT_SECRET && env.JWT_SECRET.length < 32)) {
      ctx.addIssue({ code: 'custom', path: ['JWT_SECRET'], message: `mínimo de 32 caracteres ${where}` })
    }
    if (
      (explicitProd && !env.PAYMENT_WEBHOOK_SECRET) ||
      (env.PAYMENT_WEBHOOK_SECRET && env.PAYMENT_WEBHOOK_SECRET.length < 32)
    ) {
      ctx.addIssue({ code: 'custom', path: ['PAYMENT_WEBHOOK_SECRET'], message: `mínimo de 32 caracteres ${where}` })
    }
    // Chaves de dados: sem valor efêmero (dados cifrados com chave perdida ficam ilegíveis para sempre).
    for (const k of ['DATA_KEY', 'DATA_INDEX_KEY'] as const) {
      if (!env[k]) ctx.addIssue({ code: 'custom', path: [k], message: `obrigatório ${where} (32+ caracteres; guarde fora do banco e do repositório)` })
    }
    if (env.DATA_KEY && env.DATA_KEY === env.DATA_INDEX_KEY) {
      ctx.addIssue({ code: 'custom', path: ['DATA_INDEX_KEY'], message: 'deve ser diferente de DATA_KEY' })
    }
  })
  .transform((env) => {
    const devLike = env.NODE_ENV === 'development' || env.NODE_ENV === 'test'
    const ephemeral = () => randomBytes(48).toString('base64url')
    const warnings: string[] = []
    if (!env.NODE_ENV) warnings.push('NODE_ENV ausente: aplicando regras de produção.')
    if (!devLike && !env.JWT_SECRET) warnings.push('JWT_SECRET ausente: usando segredo aleatório efêmero (sessões caem a cada restart).')
    if (!devLike && !env.PAYMENT_WEBHOOK_SECRET) {
      warnings.push('PAYMENT_WEBHOOK_SECRET ausente: segredo aleatório efêmero (webhooks serão recusados).')
    }
    return {
      ...env,
      NODE_ENV: env.NODE_ENV ?? ('production' as const),
      JWT_SECRET: env.JWT_SECRET ?? (devLike ? DEV_JWT_SECRET : ephemeral()),
      PAYMENT_WEBHOOK_SECRET: env.PAYMENT_WEBHOOK_SECRET ?? (devLike ? DEV_WEBHOOK_SECRET : ephemeral()),
      // Fora de dev/test o superRefine já exigiu as duas; o fallback só vale em dev/test.
      DATA_KEY: env.DATA_KEY ?? DEV_DATA_KEY,
      DATA_INDEX_KEY: env.DATA_INDEX_KEY ?? DEV_DATA_INDEX_KEY,
      isProduction: !devLike,
      isTest: env.NODE_ENV === 'test',
      /** Simulação de pagamento só com NODE_ENV=development|test explícito. */
      allowPaymentSimulation: devLike,
      warnings,
    }
  })

export type Env = z.output<typeof envSchema>

export class EnvError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Configuração inválida:\n${issues.map((i) => `  - ${i}`).join('\n')}`)
    this.name = 'EnvError'
  }
}

/** Valida variáveis de ambiente. Lança EnvError com a lista de problemas (sem valores). */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const parsed = envSchema.safeParse(source)
  if (!parsed.success) {
    throw new EnvError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`))
  }
  return parsed.data
}
