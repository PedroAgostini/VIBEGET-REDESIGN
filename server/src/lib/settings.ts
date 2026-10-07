import { sql } from 'drizzle-orm'
import { z } from 'zod'
import type { Env } from '../config/env.js'
import type { Db, DbOrTx } from '../db/client.js'
import { settings as settingsTable } from '../db/schema.js'
import { audit } from './audit.js'
import { AppError } from './errors.js'

/** Teto dos bônus: R$ 1.000,00 em GetCoin por evento (sanidade contra erro de digitação). */
export const MAX_BONUS_CENTS = 100_000

const fields = {
  welcomeBonusCents: z.number().int().min(0).max(MAX_BONUS_CENTS),
  referralBonusCents: z.number().int().min(0).max(MAX_BONUS_CENTS),
  getCutoffSeconds: z.number().int().min(0).max(3600),
  paymentGraceSeconds: z.number().int().min(0).max(3600),
  defaultCashbackPercent: z.number().int().min(0).max(100),
  // D6: saque do saldo em R$ (centavos)
  withdrawMinCents: z.number().int().min(1).max(10_000_000),
  withdrawDailyMaxCents: z.number().int().min(1).max(100_000_000),
  // D11: compra avulsa de GetCoin (preço de 1 GetCoin em centavos de R$; faixa em centavos de GetCoin)
  getcoinUnitPriceCents: z.number().int().min(1).max(100_000),
  getcoinCustomMinCents: z.number().int().min(100).max(100_000_000).refine((v) => v % 100 === 0, "Use GetCoins inteiros (múltiplos de 100)."),
  getcoinCustomMaxCents: z.number().int().min(100).max(100_000_000).refine((v) => v % 100 === 0, "Use GetCoins inteiros (múltiplos de 100)."),
  getcoinCustomEnabled: z.boolean(),
  // D12: marketplace
  marketFeePercent: z.number().int().min(0).max(50),
  marketMinUnitPriceCents: z.number().int().min(1).max(100_000),
  marketMaxUnitPriceCents: z.number().int().min(1).max(100_000),
  marketMinListingCents: z.number().int().min(100).max(100_000_000).refine((v) => v % 100 === 0, "Use GetCoins inteiros (múltiplos de 100)."),
  marketEnabled: z.boolean(),
  // QA-23: anti-reserva sem custo
  marketMaxPendingOrders: z.number().int().min(1).max(20),
  marketOrderTtlMinutes: z.number().int().min(1).max(60),
}

const graceRule = (s: { getCutoffSeconds: number; paymentGraceSeconds: number }) =>
  s.paymentGraceSeconds <= s.getCutoffSeconds

/** Objeto completo (sempre validado inteiro, inclusive a regra grace <= cutoff). */
export const settingsSchema = z
  .object(fields)
  .strict()
  .refine(graceRule, {
    path: ['paymentGraceSeconds'],
    message: 'paymentGraceSeconds não pode ser maior que getCutoffSeconds (o pagamento precisa fechar antes do fim).',
  })
  .refine((s) => s.getcoinCustomMinCents <= s.getcoinCustomMaxCents, {
    path: ['getcoinCustomMinCents'],
    message: 'getcoinCustomMinCents não pode ser maior que getcoinCustomMaxCents.',
  })
  .refine((s) => s.marketMinUnitPriceCents <= s.marketMaxUnitPriceCents, {
    path: ['marketMinUnitPriceCents'],
    message: 'marketMinUnitPriceCents não pode ser maior que marketMaxUnitPriceCents.',
  })
  .refine((s) => s.withdrawMinCents <= s.withdrawDailyMaxCents, {
    path: ['withdrawMinCents'],
    message: 'withdrawMinCents não pode ser maior que withdrawDailyMaxCents.',
  })

/** PATCH: parcial; a validação cruzada roda depois do merge com os valores atuais. */
/**
 * Grupos expostos pela API (o armazenamento é um só):
 * - "geral" (D3) em /admin/settings: bônus, corte, margem, cashback padrão;
 * - "saques" (D6) em /admin/settings/withdrawals: withdrawMinCents, withdrawDailyMaxCents.
 * O grupo geral não inclui as chaves de saque para manter o contrato de /admin/settings da rodada D3.
 */
export const GENERAL_KEYS = ['welcomeBonusCents', 'referralBonusCents', 'getCutoffSeconds', 'paymentGraceSeconds', 'defaultCashbackPercent'] as const
export const WITHDRAW_KEYS = ['withdrawMinCents', 'withdrawDailyMaxCents'] as const
export const GETCOIN_KEYS = ['getcoinUnitPriceCents', 'getcoinCustomMinCents', 'getcoinCustomMaxCents', 'getcoinCustomEnabled'] as const
export const MARKET_KEYS = ['marketFeePercent', 'marketMinUnitPriceCents', 'marketMaxUnitPriceCents', 'marketMinListingCents', 'marketEnabled', 'marketMaxPendingOrders', 'marketOrderTtlMinutes'] as const

const pickSchema = <K extends keyof typeof fields>(keys: readonly K[]) =>
  z
    .object(Object.fromEntries(keys.map((k) => [k, fields[k]])) as { [P in K]: (typeof fields)[P] })
    .partial()
    .strict()
    .refine((d) => Object.keys(d).length > 0, { message: 'Nada para atualizar.' })

export const settingsPatchSchema = pickSchema(GENERAL_KEYS)
export const withdrawSettingsPatchSchema = pickSchema(WITHDRAW_KEYS)
export const getcoinSettingsPatchSchema = pickSchema(GETCOIN_KEYS)
export const marketSettingsPatchSchema = pickSchema(MARKET_KEYS)

export function pickSettings<K extends keyof Settings>(s: Settings, keys: readonly K[]): Pick<Settings, K> {
  return Object.fromEntries(keys.map((k) => [k, s[k]])) as Pick<Settings, K>
}

export type Settings = z.output<typeof settingsSchema>
export type SettingKey = keyof Settings
export const SETTING_KEYS = Object.keys(fields) as SettingKey[]

/** Valores iniciais: vêm do env (D3: env é só o valor inicial). */
export function defaultSettings(env: Env): Settings {
  return {
    welcomeBonusCents: Math.min(env.WELCOME_BONUS_CENTS, MAX_BONUS_CENTS),
    referralBonusCents: Math.min(env.REFERRAL_BONUS_CENTS, MAX_BONUS_CENTS),
    getCutoffSeconds: env.GET_CUTOFF_SECONDS,
    paymentGraceSeconds: Math.min(env.PAYMENT_GRACE_SECONDS, env.GET_CUTOFF_SECONDS),
    defaultCashbackPercent: env.DEFAULT_CASHBACK_PERCENT,
    withdrawMinCents: env.WITHDRAW_MIN_CENTS,
    withdrawDailyMaxCents: Math.max(env.WITHDRAW_DAILY_MAX_CENTS, env.WITHDRAW_MIN_CENTS),
    getcoinUnitPriceCents: env.GETCOIN_UNIT_PRICE_CENTS,
    getcoinCustomMinCents: env.GETCOIN_CUSTOM_MIN_CENTS,
    getcoinCustomMaxCents: Math.max(env.GETCOIN_CUSTOM_MAX_CENTS, env.GETCOIN_CUSTOM_MIN_CENTS),
    getcoinCustomEnabled: env.GETCOIN_CUSTOM_ENABLED,
    marketFeePercent: env.MARKET_FEE_PERCENT,
    marketMinUnitPriceCents: env.MARKET_MIN_UNIT_PRICE_CENTS,
    marketMaxUnitPriceCents: Math.max(env.MARKET_MAX_UNIT_PRICE_CENTS, env.MARKET_MIN_UNIT_PRICE_CENTS),
    marketMinListingCents: env.MARKET_MIN_LISTING_CENTS,
    marketEnabled: env.MARKET_ENABLED,
    marketMaxPendingOrders: env.MARKET_MAX_PENDING_ORDERS,
    marketOrderTtlMinutes: env.MARKET_ORDER_TTL_MINUTES,
  }
}

type ReadResult = { ok: true; value: Settings } | { ok: false; issues: string[] }

async function readAll(db: DbOrTx, defaults: Settings): Promise<ReadResult> {
  const rows = await db.select().from(settingsTable)
  const merged: Record<string, unknown> = { ...defaults }
  for (const r of rows) if ((SETTING_KEYS as string[]).includes(r.key)) merged[r.key] = r.value
  const parsed = settingsSchema.safeParse(merged)
  if (parsed.success) return { ok: true, value: parsed.data }
  return { ok: false, issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) }
}

type Logger = { error: (obj: object, msg: string) => void }

/**
 * Leitura com cache em memória invalidado no PATCH desta instância.
 * Multi-instância: a mudança feita numa instância chega às outras em até CACHE_TTL_MS (5 s).
 * Linha inválida no banco (QA-19): loga erro e mantém o ÚLTIMO valor válido; sem valor válido anterior,
 * falha alto (500 SETTINGS_INVALID) em vez de voltar em silêncio para o env.
 */
export class SettingsStore {
  static readonly CACHE_TTL_MS = 5_000
  private cache: { value: Settings; at: number } | null = null
  private lastGood: Settings | null = null

  constructor(
    private readonly db: Db,
    private readonly env: Env,
    private readonly log: Logger = { error: (obj, msg) => console.error(msg, obj) },
  ) {}

  get defaults(): Settings {
    return defaultSettings(this.env)
  }

  invalidate() {
    this.cache = null
  }

  async get(): Promise<Settings> {
    if (this.cache && Date.now() - this.cache.at < SettingsStore.CACHE_TTL_MS) return this.cache.value
    const r = await readAll(this.db, this.defaults)
    if (!r.ok) {
      this.log.error({ issues: r.issues }, 'configurações inválidas no banco (tabela settings)')
      if (!this.lastGood) {
        throw new AppError(500, 'SETTINGS_INVALID', 'Configuração do sistema inválida. Avise o administrador.')
      }
      this.cache = { value: this.lastGood, at: Date.now() }
      return this.lastGood
    }
    this.lastGood = r.value
    this.cache = { value: r.value, at: Date.now() }
    return r.value
  }

  /** Atualiza (ADMIN). Serializa com advisory lock, valida o objeto final e audita de -> para. */
  async update(patch: Partial<Settings>, actorId: string | null, ip: string | null): Promise<Settings> {
    const result = await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('vibeget.settings'))`)
      const read = await readAll(tx, this.defaults)
      // Banco inválido: o PATCH do ADMIN é o caminho de correção; parte do último valor válido e regrava tudo.
      const current = read.ok ? read.value : (this.lastGood ?? this.defaults)
      const rewriteAll = !read.ok
      const next = { ...current, ...patch }
      const parsed = settingsSchema.safeParse(next)
      if (!parsed.success) {
        throw new AppError(
          400,
          'VALIDATION_ERROR',
          'Configuração inválida.',
          parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        )
      }
      const changes: Record<string, { from: unknown; to: unknown }> = {}
      for (const key of SETTING_KEYS) {
        if (!rewriteAll && current[key] === parsed.data[key]) continue
        changes[key] = { from: current[key], to: parsed.data[key] }
        await tx
          .insert(settingsTable)
          .values({ key, value: parsed.data[key], updatedById: actorId })
          .onConflictDoUpdate({ target: settingsTable.key, set: { value: parsed.data[key], updatedById: actorId } })
      }
      if (Object.keys(changes).length > 0) {
        await audit(tx, { actorId, action: 'SETTINGS_UPDATED', entity: 'settings', metadata: { changes }, ip })
      }
      return parsed.data
    })
    this.lastGood = result
    this.cache = { value: result, at: Date.now() }
    return result
  }

  /** Seed: grava os valores iniciais só para chaves que ainda não existem. */
  async seedDefaults(): Promise<number> {
    let n = 0
    for (const key of SETTING_KEYS) {
      const r = await this.db
        .insert(settingsTable)
        .values({ key, value: this.defaults[key] })
        .onConflictDoNothing()
        .returning({ key: settingsTable.key })
      n += r.length
    }
    this.invalidate()
    return n
  }
}
