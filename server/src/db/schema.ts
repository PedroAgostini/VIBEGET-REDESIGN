import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  check,
  customType,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'
import { decryptField, encryptField } from '../lib/field-crypto.js'

/**
 * Dado pessoal cifrado (AES-256-GCM, ver lib/field-crypto.ts). O código lê e grava texto normal;
 * no banco (e em qualquer backup ou cópia) fica só `enc:v1:...`.
 * ATENÇÃO: não use estas colunas em WHERE/ORDER BY/LIKE (a cifra muda a cada gravação);
 * para buscar por igualdade use o índice cego (email_hash, cpf_hash).
 */
const encryptedText = customType<{ data: string; driverData: string }>({
  dataType: () => 'text',
  toDriver: (value) => encryptField(value),
  fromDriver: (value) => decryptField(value),
})

/** Bytes brutos (bytea). PGlite devolve Uint8Array e node-postgres Buffer: normaliza para Buffer. */
const bytea = customType<{ data: Buffer; driverData: Buffer | Uint8Array }>({
  dataType: () => 'bytea',
  fromDriver: (value) => Buffer.from(value),
})

// ---------- enums ----------
export const userRole = pgEnum('user_role', ['USER', 'SUPPORT', 'ADMIN'])
export const userLevel = pgEnum('user_level', ['EXPLORADOR', 'VIBER'])
export const userStatus = pgEnum('user_status', ['ACTIVE', 'SUSPENDED', 'DELETED'])
export const authTokenType = pgEnum('auth_token_type', ['EMAIL_VERIFY', 'PASSWORD_RESET'])
export const ledgerType = pgEnum('ledger_type', [
  'WELCOME_BONUS',
  'CASHBACK',
  'SPEND_ON_GET',
  'REFUND',
  'REFERRAL',
  'ADJUSTMENT',
  'COUPON',
  'PURCHASE',
  'PURCHASE_BONUS',
  // D12: custódia do marketplace e compra entre usuários
  'MARKET_ESCROW',
  'MARKET_ESCROW_RETURN',
  'MARKET_BUY',
])
export const productCategory = pgEnum('product_category', [
  'smartphones',
  'notebooks',
  'games',
  'audio',
  'wearables',
])
export const vibeStatus = pgEnum('vibe_status', ['DRAFT', 'SCHEDULED', 'LIVE', 'ENDED', 'CANCELLED'])
export const getStatus = pgEnum('get_status', ['PENDING_PAYMENT', 'CONFIRMED', 'FAILED', 'REFUNDED'])
// INTERNAL = pago com saldo em R$ (D6), sem provedor externo
export const paymentProvider = pgEnum('payment_provider', ['MOCK', 'INTERNAL'])
export const paymentMethod = pgEnum('payment_method', ['PIX', 'CARD', 'BALANCE'])
export const cashLedgerType = pgEnum('cash_ledger_type', [
  'GET_PAYMENT',
  'GETCOIN_PURCHASE',
  'WITHDRAWAL',
  'WITHDRAWAL_REVERSAL',
  'ADJUSTMENT',
  'REFUND',
  'MARKETPLACE_SALE',
  'MARKETPLACE_FEE',
])
export const marketListingStatus = pgEnum('market_listing_status', ['ACTIVE', 'SOLD_OUT', 'CANCELLED'])
export const purchaseStatus = pgEnum('purchase_status', ['PENDING_PAYMENT', 'PAID', 'FAILED', 'REFUNDED'])
export const withdrawalStatus = pgEnum('withdrawal_status', ['PENDING', 'PAID', 'REJECTED'])
export const pixKeyType = pgEnum('pix_key_type', ['CPF', 'EMAIL', 'PHONE', 'RANDOM'])
export const paymentStatus = pgEnum('payment_status', ['PENDING', 'PAID', 'FAILED', 'REFUNDED'])
// D13: entrega do prêmio ao vencedor da Vibe
export const prizeStatus = pgEnum('prize_status', ['AWAITING_ADDRESS', 'PREPARING', 'SHIPPED', 'DELIVERED'])

// ---------- helpers ----------
const id = () =>
  uuid('id')
    .primaryKey()
    .$defaultFn(() => randomUUID())
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date())
/** Valores monetários sempre em centavos inteiros. */
const cents = (name: string) => bigint(name, { mode: 'number' })

// ---------- tabelas ----------
export const users = pgTable(
  'users',
  {
    id: id(),
    name: varchar('name', { length: 120 }).notNull(),
    email: encryptedText('email').notNull(),
    // Índice cego (HMAC) do e-mail em minúsculas: login, cadastro e unicidade.
    emailHash: varchar('email_hash', { length: 64 }).notNull(),
    cpf: encryptedText('cpf'),
    cpfHash: varchar('cpf_hash', { length: 64 }),
    phone: encryptedText('phone'),
    birthDate: encryptedText('birth_date'),
    passwordHash: text('password_hash').notNull(),
    role: userRole('role').notNull().default('USER'),
    level: userLevel('level').notNull().default('EXPLORADOR'),
    status: userStatus('status').notNull().default('ACTIVE'),
    emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
    failedLoginCount: integer('failed_login_count').notNull().default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    referralCode: varchar('referral_code', { length: 16 }).notNull(),
    referredById: uuid('referred_by_id'),
    termsAcceptedAt: timestamp('terms_accepted_at', { withTimezone: true }),
    termsVersion: varchar('terms_version', { length: 32 }),
    marketingOptIn: boolean('marketing_opt_in').notNull().default(false),
    // D8: endereço (opcional até a entrega de um prêmio)
    cep: encryptedText('cep'),
    street: encryptedText('street'),
    number: encryptedText('number'),
    complement: encryptedText('complement'),
    district: encryptedText('district'),
    city: encryptedText('city'),
    state: varchar('state', { length: 2 }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('users_email_hash_uq').on(t.emailHash),
    uniqueIndex('users_cpf_hash_uq').on(t.cpfHash),
    uniqueIndex('users_referral_code_uq').on(t.referralCode),
    index('users_created_at_idx').on(t.createdAt),
    // CPF e e-mail não podem ser checados no banco (estão cifrados); a validação é do app (zod).
    check('users_cpf_hash_ck', sql`(${t.cpf} IS NULL) = (${t.cpfHash} IS NULL)`),
  ],
)

export const sessions = pgTable(
  'sessions',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: varchar('token_hash', { length: 64 }).notNull(),
    familyId: uuid('family_id').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    replacedById: uuid('replaced_by_id'),
    userAgent: encryptedText('user_agent'),
    ip: encryptedText('ip'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('sessions_token_hash_uq').on(t.tokenHash),
    index('sessions_family_idx').on(t.familyId),
    index('sessions_user_idx').on(t.userId),
  ],
)

export const authTokens = pgTable(
  'auth_tokens',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: authTokenType('type').notNull(),
    tokenHash: varchar('token_hash', { length: 64 }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('auth_tokens_hash_uq').on(t.tokenHash),
    index('auth_tokens_user_type_idx').on(t.userId, t.type),
  ],
)

export const wallets = pgTable(
  'wallets',
  {
    userId: uuid('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    balanceCents: cents('balance_cents').notNull().default(0),
    updatedAt: updatedAt(),
  },
  (t) => [check('wallets_balance_non_negative_ck', sql`${t.balanceCents} >= 0`)],
)

export const getcoinLedger = pgTable(
  'getcoin_ledger',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    amountCents: cents('amount_cents').notNull(),
    balanceAfterCents: cents('balance_after_cents').notNull(),
    /** QA-18: ordem de inserção determinística (created_at empata dentro da mesma transação). */
    seq: bigint('seq', { mode: 'number' }).generatedAlwaysAsIdentity().notNull(),
    type: ledgerType('type').notNull(),
    referenceType: varchar('reference_type', { length: 32 }),
    referenceId: uuid('reference_id'),
    reason: varchar('reason', { length: 500 }),
    createdById: uuid('created_by_id'),
    createdAt: createdAt(),
  },
  (t) => [
    index('ledger_user_created_idx').on(t.userId, t.createdAt),
    index('ledger_reference_idx').on(t.referenceType, t.referenceId),
    check('ledger_amount_non_zero_ck', sql`${t.amountCents} <> 0`),
  ],
)

export const products = pgTable(
  'products',
  {
    id: id(),
    slug: varchar('slug', { length: 120 }).notNull(),
    name: varchar('name', { length: 160 }).notNull(),
    category: productCategory('category').notNull(),
    imageUrl: varchar('image_url', { length: 500 }),
    originalPriceCents: cents('original_price_cents').notNull(),
    description: text('description'),
    // D10: página da Vibe — marca, modelo, galeria (a capa continua em image_url) e ficha técnica
    brand: varchar('brand', { length: 80 }),
    model: varchar('model', { length: 120 }),
    images: jsonb('images').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    specs: jsonb('specs').$type<Array<{ label: string; value: string }>>().notNull().default(sql`'[]'::jsonb`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('products_slug_uq').on(t.slug),
    check('products_price_positive_ck', sql`${t.originalPriceCents} > 0`),
  ],
)

export const vibes = pgTable(
  'vibes',
  {
    id: id(),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id),
    slug: varchar('slug', { length: 140 }).notNull(),
    status: vibeStatus('status').notNull().default('DRAFT'),
    minGetCents: cents('min_get_cents').notNull(),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    goalGets: integer('goal_gets'),
    cashbackPercent: integer('cashback_percent').notNull().default(40),
    winnerGetId: uuid('winner_get_id'),
    settledAt: timestamp('settled_at', { withTimezone: true }),
    // D10: benefícios extras desta Vibe (os fixos da plataforma ficam no front) e total de visitantes únicos/dia
    benefits: jsonb('benefits').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    viewsCount: integer('views_count').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('vibes_slug_uq').on(t.slug),
    index('vibes_status_ends_idx').on(t.status, t.endsAt),
    check('vibes_min_get_positive_ck', sql`${t.minGetCents} > 0`),
    check('vibes_cashback_range_ck', sql`${t.cashbackPercent} BETWEEN 0 AND 100`),
    check('vibes_dates_ck', sql`${t.endsAt} > ${t.startsAt}`),
    check('vibes_goal_positive_ck', sql`${t.goalGets} IS NULL OR ${t.goalGets} > 0`),
  ],
)

/** D10: uma linha por visitante por dia por Vibe. visitor_hash = SHA-256 de um id aleatório de cookie (sem dado pessoal). */
export const vibeViews = pgTable(
  'vibe_views',
  {
    vibeId: uuid('vibe_id')
      .notNull()
      .references(() => vibes.id, { onDelete: 'cascade' }),
    visitorHash: varchar('visitor_hash', { length: 64 }).notNull(),
    day: date('day').notNull(),
  },
  (t) => [uniqueIndex('vibe_views_uq').on(t.vibeId, t.visitorHash, t.day)],
)

/** D10: Vibes favoritadas pelo usuário. */
export const favorites = pgTable(
  'favorites',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    vibeId: uuid('vibe_id')
      .notNull()
      .references(() => vibes.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('favorites_uq').on(t.userId, t.vibeId), index('favorites_vibe_idx').on(t.vibeId)],
)

export const gets = pgTable(
  'gets',
  {
    id: id(),
    vibeId: uuid('vibe_id')
      .notNull()
      .references(() => vibes.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    cashCents: cents('cash_cents').notNull(),
    getcoinCents: cents('getcoin_cents').notNull().default(0),
    totalCents: cents('total_cents').notNull(),
    status: getStatus('status').notNull().default('PENDING_PAYMENT'),
    idempotencyKey: varchar('idempotency_key', { length: 128 }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('gets_user_idempotency_uq').on(t.userId, t.idempotencyKey),
    index('gets_vibe_status_total_idx').on(t.vibeId, t.status, t.totalCents),
    index('gets_user_created_idx').on(t.userId, t.createdAt),
    check('gets_cash_positive_ck', sql`${t.cashCents} > 0`),
    check('gets_getcoin_range_ck', sql`${t.getcoinCents} >= 0 AND ${t.getcoinCents} <= ${t.cashCents}`),
    check('gets_total_ck', sql`${t.totalCents} = ${t.cashCents} + ${t.getcoinCents}`),
  ],
)

export const payments = pgTable(
  'payments',
  {
    id: id(),
    // D7: o pagamento é de um Get OU de uma compra de GetCoin (CHECK exige exatamente um)
    getId: uuid('get_id').references(() => gets.id),
    purchaseId: uuid('purchase_id').references(() => getcoinPurchases.id),
    // D12: pagamento de pedido do marketplace
    orderId: uuid('order_id').references(() => marketOrders.id),
    provider: paymentProvider('provider').notNull().default('MOCK'),
    method: paymentMethod('method').notNull(),
    status: paymentStatus('status').notNull().default('PENDING'),
    amountCents: cents('amount_cents').notNull(),
    externalId: varchar('external_id', { length: 128 }).notNull(),
    pixCopyPaste: text('pix_copy_paste'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('payments_external_id_uq').on(t.externalId),
    uniqueIndex('payments_get_uq').on(t.getId),
    uniqueIndex('payments_purchase_uq').on(t.purchaseId),
    uniqueIndex('payments_order_uq').on(t.orderId),
    // exatamente um alvo: Get, compra de GetCoin ou pedido do marketplace
    check(
      'payments_one_target_ck',
      sql`(CASE WHEN ${t.getId} IS NULL THEN 0 ELSE 1 END + CASE WHEN ${t.purchaseId} IS NULL THEN 0 ELSE 1 END + CASE WHEN ${t.orderId} IS NULL THEN 0 ELSE 1 END) = 1`,
    ),
    index('payments_status_expires_idx').on(t.status, t.expiresAt),
    check('payments_amount_positive_ck', sql`${t.amountCents} > 0`),
  ],
)

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: id(),
    actorId: uuid('actor_id'),
    action: varchar('action', { length: 64 }).notNull(),
    entity: varchar('entity', { length: 32 }).notNull(),
    entityId: uuid('entity_id'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    ip: encryptedText('ip'),
    createdAt: createdAt(),
  },
  (t) => [
    index('audit_created_idx').on(t.createdAt),
    index('audit_actor_idx').on(t.actorId),
    index('audit_entity_idx').on(t.entity, t.entityId),
  ],
)

/** D3: configurações editáveis pelo ADMIN (chave -> valor JSON validado por Zod em lib/settings.ts). */
export const settings = pgTable('settings', {
  key: varchar('key', { length: 64 }).primaryKey(),
  value: jsonb('value').notNull(),
  updatedById: uuid('updated_by_id'),
  updatedAt: updatedAt(),
})

/** D4: cupons que creditam GetCoin. `code` guardado em MAIÚSCULAS (único, sem diferenciar caixa). */
export const coupons = pgTable(
  'coupons',
  {
    id: id(),
    code: varchar('code', { length: 40 }).notNull(),
    amountCents: cents('amount_cents').notNull(),
    maxRedemptions: integer('max_redemptions'),
    perUserLimit: integer('per_user_limit').notNull().default(1),
    redemptionsCount: integer('redemptions_count').notNull().default(0),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull().defaultNow(),
    endsAt: timestamp('ends_at', { withTimezone: true }),
    active: boolean('active').notNull().default(true),
    newAccountsOnly: boolean('new_accounts_only').notNull().default(false),
    description: varchar('description', { length: 200 }),
    createdById: uuid('created_by_id'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('coupons_code_uq').on(t.code),
    check('coupons_code_upper_ck', sql`${t.code} = upper(${t.code})`),
    check('coupons_amount_positive_ck', sql`${t.amountCents} > 0`),
    check('coupons_max_positive_ck', sql`${t.maxRedemptions} IS NULL OR ${t.maxRedemptions} > 0`),
    check('coupons_per_user_positive_ck', sql`${t.perUserLimit} > 0`),
    check(
      'coupons_count_ck',
      sql`${t.redemptionsCount} >= 0 AND (${t.maxRedemptions} IS NULL OR ${t.redemptionsCount} <= ${t.maxRedemptions})`,
    ),
    check('coupons_dates_ck', sql`${t.endsAt} IS NULL OR ${t.endsAt} > ${t.startsAt}`),
  ],
)

/**
 * Resgates. `seq` = n-ésimo resgate do usuário naquele cupom (1..per_user_limit);
 * UNIQUE(coupon_id, user_id, seq) garante no banco o limite por usuário (com limite 1 vira UNIQUE(coupon_id, user_id)).
 */
export const couponRedemptions = pgTable(
  'coupon_redemptions',
  {
    id: id(),
    couponId: uuid('coupon_id')
      .notNull()
      .references(() => coupons.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    seq: integer('seq').notNull().default(1),
    amountCents: cents('amount_cents').notNull(),
    ledgerId: uuid('ledger_id').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('coupon_redemptions_user_seq_uq').on(t.couponId, t.userId, t.seq),
    index('coupon_redemptions_coupon_idx').on(t.couponId, t.createdAt),
    check('coupon_redemptions_seq_ck', sql`${t.seq} > 0`),
  ],
)

/** D6: saldo em R$ sacável (centavos). Separado do GetCoin. */
export const cashWallets = pgTable(
  'cash_wallets',
  {
    userId: uuid('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    balanceCents: cents('balance_cents').notNull().default(0),
    updatedAt: updatedAt(),
  },
  (t) => [check('cash_wallets_balance_non_negative_ck', sql`${t.balanceCents} >= 0`)],
)

/** D6: livro-razão do saldo em R$ (imutável por trigger, como o getcoin_ledger). */
export const cashLedger = pgTable(
  'cash_ledger',
  {
    id: id(),
    seq: bigint('seq', { mode: 'number' }).generatedAlwaysAsIdentity().notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    amountCents: cents('amount_cents').notNull(),
    balanceAfterCents: cents('balance_after_cents').notNull(),
    type: cashLedgerType('type').notNull(),
    referenceType: varchar('reference_type', { length: 32 }),
    referenceId: uuid('reference_id'),
    reason: varchar('reason', { length: 500 }),
    createdById: uuid('created_by_id'),
    createdAt: createdAt(),
  },
  (t) => [
    index('cash_ledger_user_created_idx').on(t.userId, t.createdAt),
    index('cash_ledger_reference_idx').on(t.referenceType, t.referenceId),
    check('cash_ledger_amount_non_zero_ck', sql`${t.amountCents} <> 0`),
  ],
)

/** D7: pacotes de GetCoin vendidos pelo admin. */
export const getcoinPackages = pgTable(
  'getcoin_packages',
  {
    id: id(),
    name: varchar('name', { length: 80 }).notNull(),
    getcoinsCents: cents('getcoins_cents').notNull(),
    bonusCents: cents('bonus_cents').notNull().default(0),
    priceCents: cents('price_cents').notNull(),
    active: boolean('active').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('getcoin_packages_getcoins_positive_ck', sql`${t.getcoinsCents} > 0`),
    check('getcoin_packages_bonus_ck', sql`${t.bonusCents} >= 0`),
    check('getcoin_packages_price_positive_ck', sql`${t.priceCents} > 0`),
  ],
)

/** D7: compra de pacote (snapshot dos valores do pacote no momento da compra). */
export const getcoinPurchases = pgTable(
  'getcoin_purchases',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    // D11: null = compra avulsa
    packageId: uuid('package_id').references(() => getcoinPackages.id),
    packageName: varchar('package_name', { length: 80 }).notNull(),
    getcoinsCents: cents('getcoins_cents').notNull(),
    bonusCents: cents('bonus_cents').notNull().default(0),
    priceCents: cents('price_cents').notNull(),
    method: paymentMethod('method').notNull(),
    status: purchaseStatus('status').notNull().default('PENDING_PAYMENT'),
    idempotencyKey: varchar('idempotency_key', { length: 128 }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('getcoin_purchases_user_idempotency_uq').on(t.userId, t.idempotencyKey),
    index('getcoin_purchases_user_created_idx').on(t.userId, t.createdAt),
    check('getcoin_purchases_values_ck', sql`${t.getcoinsCents} > 0 AND ${t.bonusCents} >= 0 AND ${t.priceCents} > 0`),
  ],
)

/** D6: saque do saldo em R$ via Pix, com aprovação do ADMIN. pix_key completa só para o ADMIN pagar. */
export const withdrawals = pgTable(
  'withdrawals',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    amountCents: cents('amount_cents').notNull(),
    pixKeyType: pixKeyType('pix_key_type').notNull(),
    pixKey: encryptedText('pix_key').notNull(),
    status: withdrawalStatus('status').notNull().default('PENDING'),
    idempotencyKey: varchar('idempotency_key', { length: 128 }).notNull(),
    decidedById: uuid('decided_by_id'),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    rejectReason: varchar('reject_reason', { length: 500 }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('withdrawals_user_idempotency_uq').on(t.userId, t.idempotencyKey),
    index('withdrawals_status_created_idx').on(t.status, t.createdAt),
    index('withdrawals_user_created_idx').on(t.userId, t.createdAt),
    check('withdrawals_amount_positive_ck', sql`${t.amountCents} > 0`),
  ],
)

/** D12: anúncio de GetCoins. remaining = disponível para novos pedidos (pedidos pendentes já saíram daqui). */
export const marketListings = pgTable(
  'market_listings',
  {
    id: id(),
    sellerId: uuid('seller_id')
      .notNull()
      .references(() => users.id),
    unitPriceCents: cents('unit_price_cents').notNull(),
    totalCents: cents('total_cents').notNull(),
    remainingCents: cents('remaining_cents').notNull(),
    status: marketListingStatus('status').notNull().default('ACTIVE'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('market_listings_status_price_idx').on(t.status, t.unitPriceCents),
    index('market_listings_seller_idx').on(t.sellerId, t.createdAt),
    check('market_listings_unit_price_ck', sql`${t.unitPriceCents} > 0`),
    check('market_listings_total_ck', sql`${t.totalCents} > 0 AND ${t.totalCents} % 100 = 0`),
    check('market_listings_remaining_ck', sql`${t.remainingCents} >= 0 AND ${t.remainingCents} <= ${t.totalCents} AND ${t.remainingCents} % 100 = 0`),
  ],
)

/** D12: pedido de compra num anúncio (snapshot do preço e da taxa no momento do pedido). */
export const marketOrders = pgTable(
  'market_orders',
  {
    id: id(),
    listingId: uuid('listing_id')
      .notNull()
      .references(() => marketListings.id),
    buyerId: uuid('buyer_id')
      .notNull()
      .references(() => users.id),
    sellerId: uuid('seller_id')
      .notNull()
      .references(() => users.id),
    getcoinsCents: cents('getcoins_cents').notNull(),
    unitPriceCents: cents('unit_price_cents').notNull(),
    totalPriceCents: cents('total_price_cents').notNull(),
    feeCents: cents('fee_cents').notNull(),
    sellerNetCents: cents('seller_net_cents').notNull(),
    method: paymentMethod('method').notNull(),
    status: purchaseStatus('status').notNull().default('PENDING_PAYMENT'),
    idempotencyKey: varchar('idempotency_key', { length: 128 }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('market_orders_buyer_idempotency_uq').on(t.buyerId, t.idempotencyKey),
    index('market_orders_listing_status_idx').on(t.listingId, t.status),
    index('market_orders_buyer_idx').on(t.buyerId, t.createdAt),
    index('market_orders_seller_idx').on(t.sellerId, t.createdAt),
    check('market_orders_not_self_ck', sql`${t.buyerId} <> ${t.sellerId}`),
    check('market_orders_qty_ck', sql`${t.getcoinsCents} > 0 AND ${t.getcoinsCents} % 100 = 0`),
    check('market_orders_total_ck', sql`${t.totalPriceCents} = (${t.getcoinsCents} / 100) * ${t.unitPriceCents}`),
    check('market_orders_fee_ck', sql`${t.feeCents} >= 0 AND ${t.sellerNetCents} >= 0 AND ${t.feeCents} + ${t.sellerNetCents} = ${t.totalPriceCents}`),
  ],
)

/**
 * D13: entrega do prêmio. Uma por Vibe encerrada com vencedor (criada no settlement).
 * O endereço é uma cópia do momento da confirmação: mudar o perfil depois não muda a entrega.
 */
export const prizeDeliveries = pgTable(
  'prize_deliveries',
  {
    id: id(),
    vibeId: uuid('vibe_id')
      .notNull()
      .references(() => vibes.id),
    getId: uuid('get_id')
      .notNull()
      .references(() => gets.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    status: prizeStatus('status').notNull().default('AWAITING_ADDRESS'),
    recipientName: encryptedText('recipient_name'),
    phone: encryptedText('phone'),
    cep: encryptedText('cep'),
    street: encryptedText('street'),
    number: encryptedText('number'),
    complement: encryptedText('complement'),
    district: encryptedText('district'),
    city: encryptedText('city'),
    state: varchar('state', { length: 2 }),
    addressConfirmedAt: timestamp('address_confirmed_at', { withTimezone: true }),
    carrier: varchar('carrier', { length: 60 }),
    trackingCode: varchar('tracking_code', { length: 60 }),
    shippedAt: timestamp('shipped_at', { withTimezone: true }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('prize_deliveries_vibe_uq').on(t.vibeId),
    index('prize_deliveries_user_idx').on(t.userId, t.createdAt),
    index('prize_deliveries_status_idx').on(t.status, t.createdAt),
    check('prize_deliveries_shipped_ck', sql`${t.status} NOT IN ('SHIPPED', 'DELIVERED') OR (${t.carrier} IS NOT NULL AND ${t.trackingCode} IS NOT NULL)`),
  ],
)

/**
 * Fotos de produto guardadas no banco (UPLOAD_STORAGE=db): para ambientes sem disco persistente,
 * como a Vercel. Em servidor comum o padrão continua sendo o disco (UPLOAD_DIR).
 */
export const uploadedImages = pgTable('uploaded_images', {
  name: varchar('name', { length: 64 }).primaryKey(),
  contentType: varchar('content_type', { length: 32 }).notNull(),
  data: bytea('data').notNull(),
  createdAt: createdAt(),
})

export type User = typeof users.$inferSelect
export type PrizeDelivery = typeof prizeDeliveries.$inferSelect
export type Vibe = typeof vibes.$inferSelect
export type Product = typeof products.$inferSelect
export type Get = typeof gets.$inferSelect
export type Payment = typeof payments.$inferSelect
export type LedgerType = (typeof ledgerType.enumValues)[number]
export type CashLedgerType = (typeof cashLedgerType.enumValues)[number]
export type Withdrawal = typeof withdrawals.$inferSelect
export type GetcoinPurchase = typeof getcoinPurchases.$inferSelect
export type MarketListing = typeof marketListings.$inferSelect
export type MarketOrder = typeof marketOrders.$inferSelect
export type Role = (typeof userRole.enumValues)[number]
