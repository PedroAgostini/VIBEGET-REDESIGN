import { randomUUID } from 'node:crypto'
import { and, eq, isNull, lte, or, sql } from 'drizzle-orm'
import type { AppContext, RequestMeta } from '../../context.js'
import type { DbOrTx, Tx } from '../../db/client.js'
import { authTokens, sessions, users, type User } from '../../db/schema.js'
import { audit } from '../../lib/audit.js'
import {
  fakePasswordVerify,
  hashPassword,
  randomToken,
  referralCode,
  sha256,
  verifyPassword,
} from '../../lib/crypto.js'
import { AppError, badRequest, conflict, isUniqueViolation, unauthorized } from '../../lib/errors.js'
import { cpfIndex, emailIndex } from '../../lib/field-crypto.js'
import type { MailKind } from '../../lib/mailer.js'
import { safeErrorForLog } from '../../lib/log-safety.js'
import { toMe } from '../../lib/presenters.js'
import { redeemCoupon } from '../coupons/service.js'
import { applyWalletMovement, createWallet } from '../wallet/service.js'
import type { RegisterInput } from './schemas.js'

export const MAX_FAILED_LOGINS = 5
export const LOCK_MINUTES = 15
const EMAIL_VERIFY_TTL_MS = 24 * 60 * 60 * 1000
const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000

const invalidCredentials = () =>
  new AppError(
    401,
    'INVALID_CREDENTIALS',
    'E-mail ou senha inválidos. Após várias tentativas o acesso fica bloqueado por 15 minutos.',
  )
const invalidRefresh = () => unauthorized('Sessão expirada. Entre novamente.', 'INVALID_REFRESH_TOKEN')

export interface AuthResult {
  user: ReturnType<typeof toMe>
  accessToken: string
  expiresIn: number
  refreshToken: string
  refreshExpiresAt: Date
  /** Só presente no cadastro com couponCode (D4). */
  couponApplied?: boolean
}

// ---------- sessões ----------

async function createSession(
  ctx: AppContext,
  db: DbOrTx,
  userId: string,
  meta: RequestMeta,
  familyId: string = randomUUID(),
) {
  const refreshToken = randomToken()
  const expiresAt = new Date(Date.now() + ctx.env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000)
  const [s] = await db
    .insert(sessions)
    .values({
      userId,
      tokenHash: sha256(refreshToken),
      familyId,
      expiresAt,
      userAgent: meta.userAgent,
      ip: meta.ip,
    })
    .returning({ id: sessions.id })
  return { refreshToken, expiresAt, familyId, sessionId: s!.id }
}

function buildAuthResult(
  ctx: AppContext,
  user: User,
  session: { refreshToken: string; expiresAt: Date; familyId: string },
): AuthResult {
  return {
    user: toMe(user),
    accessToken: ctx.signAccessToken({ sub: user.id, sid: session.familyId, role: user.role }),
    expiresIn: ctx.env.ACCESS_TOKEN_TTL_SECONDS,
    refreshToken: session.refreshToken,
    refreshExpiresAt: session.expiresAt,
  }
}

export async function revokeAllSessions(db: DbOrTx, userId: string) {
  await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)))
}

async function revokeFamily(db: DbOrTx, familyId: string) {
  await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.familyId, familyId), isNull(sessions.revokedAt)))
}

// ---------- tokens de e-mail ----------

async function issueAuthToken(db: DbOrTx, userId: string, type: MailKind, ttlMs: number) {
  // Só um token válido por tipo: descarta os anteriores ainda não usados.
  await db
    .delete(authTokens)
    .where(and(eq(authTokens.userId, userId), eq(authTokens.type, type), isNull(authTokens.usedAt)))
  const token = randomToken()
  await db.insert(authTokens).values({
    userId,
    type,
    tokenHash: sha256(token),
    expiresAt: new Date(Date.now() + ttlMs),
  })
  return token
}

async function consumeAuthToken(tx: Tx, token: string, type: MailKind) {
  const [row] = await tx
    .select()
    .from(authTokens)
    .where(and(eq(authTokens.tokenHash, sha256(token)), eq(authTokens.type, type)))
    .for('update')
  if (!row || row.usedAt || row.expiresAt <= new Date()) return null
  await tx.update(authTokens).set({ usedAt: new Date() }).where(eq(authTokens.id, row.id))
  return row
}

async function sendVerification(ctx: AppContext, user: Pick<User, 'id' | 'email'>) {
  const token = await issueAuthToken(ctx.db, user.id, 'EMAIL_VERIFY', EMAIL_VERIFY_TTL_MS)
  await ctx.mailer.send({
    to: user.email,
    kind: 'EMAIL_VERIFY',
    subject: 'Confirme seu e-mail no VibeGet',
    link: `${ctx.env.APP_URL}/verificar-email?token=${encodeURIComponent(token)}`,
    token,
  })
}

// ---------- casos de uso ----------

async function uniqueReferralCode(db: DbOrTx): Promise<string> {
  for (let i = 0; i < 10; i++) {
    const code = referralCode()
    const [hit] = await db.select({ id: users.id }).from(users).where(eq(users.referralCode, code)).limit(1)
    if (!hit) return code
  }
  throw new Error('não foi possível gerar código de indicação único')
}

export async function register(ctx: AppContext, input: RegisterInput, meta: RequestMeta): Promise<AuthResult> {
  const { db, env } = ctx

  let referredById: string | null = null
  if (input.referralCode) {
    const [ref] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.referralCode, input.referralCode), eq(users.status, 'ACTIVE')))
      .limit(1)
    if (!ref) throw badRequest('Código de indicação inválido.', 'INVALID_REFERRAL_CODE')
    referredById = ref.id
  }

  const taken = () => conflict('Não foi possível concluir o cadastro: e-mail ou CPF já cadastrado.', 'ACCOUNT_EXISTS')
  const emailHash = emailIndex(input.email)
  const cpfHash = input.cpf ? cpfIndex(input.cpf) : null
  const [emailHit] = await db.select({ id: users.id }).from(users).where(eq(users.emailHash, emailHash)).limit(1)
  if (emailHit) throw taken()
  if (cpfHash) {
    const [cpfHit] = await db.select({ id: users.id }).from(users).where(eq(users.cpfHash, cpfHash)).limit(1)
    if (cpfHit) throw taken()
  }

  const passwordHash = await hashPassword(input.password)
  const code = await uniqueReferralCode(db)
  const cfg = await ctx.settings.get()
  const now = new Date()

  let result: { user: User; session: Awaited<ReturnType<typeof createSession>> }
  try {
    result = await db.transaction(async (tx) => {
      const [user] = await tx
        .insert(users)
        .values({
          name: input.name,
          email: input.email,
          emailHash,
          cpf: input.cpf ?? null,
          cpfHash,
          phone: input.phone ?? null,
          birthDate: input.birthDate ?? null,
          passwordHash,
          referralCode: code,
          referredById,
          termsAcceptedAt: now,
          termsVersion: env.TERMS_VERSION,
          marketingOptIn: input.marketingOptIn ?? false,
        })
        .returning()
      await createWallet(tx, user!.id)
      if (cfg.welcomeBonusCents > 0) {
        await applyWalletMovement(tx, {
          userId: user!.id,
          amountCents: cfg.welcomeBonusCents,
          type: 'WELCOME_BONUS',
          referenceType: 'user',
          referenceId: user!.id,
          reason: 'Bônus de boas-vindas (Nível Explorador)',
        })
      }
      await audit(tx, {
        actorId: user!.id,
        action: 'USER_REGISTERED',
        entity: 'user',
        entityId: user!.id,
        metadata: { termsVersion: env.TERMS_VERSION, referred: referredById !== null },
        ip: meta.ip,
      })
      const session = await createSession(ctx, tx, user!.id, meta)
      return { user: user!, session }
    })
  } catch (err) {
    if (isUniqueViolation(err)) throw taken()
    throw err
  }

  await sendVerification(ctx, result.user)
  const auth = buildAuthResult(ctx, result.user, result.session)
  if (input.couponCode !== undefined) {
    // Cupom no cadastro: tentativa separada, DEPOIS do commit. Falha não desfaz o cadastro (D4).
    try {
      await redeemCoupon(ctx, result.user.id, input.couponCode, meta)
      auth.couponApplied = true
    } catch (err) {
      if (!(err instanceof AppError && err.code === 'COUPON_UNAVAILABLE')) {
        ctx.log.error({ error: safeErrorForLog(err) }, 'falha ao aplicar cupom no cadastro')
      }
      auth.couponApplied = false
    }
  }
  return auth
}

/**
 * Reserva atomicamente uma tentativa de senha (conta o erro antes de verificar).
 * Retorna o número da tentativa, ou null se a conta está bloqueada / já tem 5 tentativas em andamento.
 * Usado por login, troca de senha e exclusão de conta. O reset por e-mail NÃO passa por aqui
 * (e zera o bloqueio), então um bloqueio malicioso não impede o titular de recuperar o acesso.
 */
export async function reservePasswordAttempt(db: DbOrTx, userId: string): Promise<number | null> {
  // Contador >= 5 fora de bloqueio (bloqueio expirado ou tentativa interrompida, QA-16) recomeça em 1.
  const next = sql`CASE WHEN ${users.failedLoginCount} >= ${MAX_FAILED_LOGINS} THEN 1 ELSE ${users.failedLoginCount} + 1 END`
  const [r] = await db
    .update(users)
    .set({
      failedLoginCount: next,
      // A 5ª reserva já grava o bloqueio no MESMO UPDATE: se o processo cair antes de registrar o erro,
      // a conta fica bloqueada só 15 min, nunca para sempre. Acerto de senha zera contador e bloqueio.
      lockedUntil: sql`CASE WHEN (${next}) >= ${MAX_FAILED_LOGINS} THEN now() + (${LOCK_MINUTES} * interval '1 minute') ELSE ${users.lockedUntil} END`,
    })
    .where(and(eq(users.id, userId), or(isNull(users.lockedUntil), lte(users.lockedUntil, sql`now()`))))
    .returning({ n: users.failedLoginCount })
  return r?.n ?? null
}

/** Tentativa reservada falhou. Na 5ª, bloqueia por 15 min e zera o contador. Retorna true se bloqueou. */
export async function registerFailedAttempt(db: DbOrTx, userId: string, reserved: number): Promise<boolean> {
  if (reserved < MAX_FAILED_LOGINS) return false
  await db
    .update(users)
    .set({ failedLoginCount: 0, lockedUntil: sql`now() + (${LOCK_MINUTES} * interval '1 minute')` })
    .where(eq(users.id, userId))
  return true
}

/** Senha conferiu: zera contador e bloqueio. */
export async function clearPasswordAttempts(db: DbOrTx, userId: string) {
  await db.update(users).set({ failedLoginCount: 0, lockedUntil: null }).where(eq(users.id, userId))
}

export const tooManyAttempts = () =>
  new AppError(
    429,
    'TOO_MANY_ATTEMPTS',
    'Muitas tentativas com senha incorreta. Tente em 15 minutos ou redefina a senha pelo e-mail.',
  )

export async function login(
  ctx: AppContext,
  input: { email: string; password: string },
  meta: RequestMeta,
): Promise<AuthResult> {
  const { db } = ctx
  const [user] = await db.select().from(users).where(eq(users.emailHash, emailIndex(input.email))).limit(1)
  // Referência para o audit log: HMAC com chave (um SHA-256 puro de e-mail se reverte por dicionário).
  const emailRef = emailIndex(input.email).slice(0, 16)

  if (!user || user.status === 'DELETED') {
    await fakePasswordVerify(input.password)
    await audit(db, { action: 'LOGIN_FAILED', entity: 'auth', metadata: { emailRef, reason: 'unknown' }, ip: meta.ip })
    throw invalidCredentials()
  }

  // Reserva a tentativa ANTES do argon2 (atômico): paralelas não furam o limite de 5 (QA-07).
  const reserved = await reservePasswordAttempt(db, user.id)
  if (reserved === null) {
    await fakePasswordVerify(input.password)
    await audit(db, {
      actorId: user.id,
      action: 'LOGIN_BLOCKED',
      entity: 'user',
      entityId: user.id,
      metadata: { reason: 'locked' },
      ip: meta.ip,
    })
    throw invalidCredentials()
  }

  const ok = await verifyPassword(user.passwordHash, input.password)
  if (!ok) {
    const locked = await registerFailedAttempt(db, user.id, reserved)
    await audit(db, {
      actorId: user.id,
      action: locked ? 'ACCOUNT_LOCKED' : 'LOGIN_FAILED',
      entity: 'user',
      entityId: user.id,
      metadata: { reason: 'bad_password' },
      ip: meta.ip,
    })
    throw invalidCredentials()
  }

  if (user.status === 'SUSPENDED') {
    await clearPasswordAttempts(db, user.id)
    await audit(db, {
      actorId: user.id,
      action: 'LOGIN_BLOCKED',
      entity: 'user',
      entityId: user.id,
      metadata: { reason: 'suspended' },
      ip: meta.ip,
    })
    throw new AppError(403, 'ACCOUNT_SUSPENDED', 'Sua conta está suspensa. Fale com o suporte.')
  }

  const [fresh] = await db
    .update(users)
    .set({ failedLoginCount: 0, lockedUntil: null })
    .where(eq(users.id, user.id))
    .returning()
  const session = await createSession(ctx, db, user.id, meta)
  await audit(db, { actorId: user.id, action: 'LOGIN_SUCCEEDED', entity: 'user', entityId: user.id, ip: meta.ip })
  return buildAuthResult(ctx, fresh!, session)
}

/**
 * Rotação de refresh token. Reuso de um token já rotacionado revoga a família inteira
 * (indício de roubo). A revogação é gravada antes de responder 401.
 */
export async function refresh(ctx: AppContext, rawToken: string | undefined, meta: RequestMeta): Promise<AuthResult> {
  if (!rawToken || rawToken.length > 200) throw invalidRefresh()
  const tokenHash = sha256(rawToken)

  const outcome = await ctx.db.transaction(async (tx) => {
    const [s] = await tx.select().from(sessions).where(eq(sessions.tokenHash, tokenHash)).for('update')
    if (!s) return { ok: false as const }

    if (s.revokedAt) {
      // Corrida legítima (duas abas / retry simultâneo, QA-06): a requisição CHEGOU antes de a rotação
      // acontecer, ou seja, o cliente não tinha como conhecer o cookie novo. Não revoga a família; responde
      // 409 REFRESH_RACE e o cliente repete com o cookie novo. Limitado à janela REFRESH_REUSE_GRACE_SECONDS.
      // Token apresentado DEPOIS da rotação continua sendo tratado como reuso (revoga a família).
      const graceMs = ctx.env.REFRESH_REUSE_GRACE_SECONDS * 1000
      const arrivedBeforeRotation = meta.receivedAt !== undefined && meta.receivedAt < s.revokedAt.getTime()
      if (s.replacedById && arrivedBeforeRotation && Date.now() - s.revokedAt.getTime() < graceMs) {
        return { ok: false as const, race: true as const }
      }
      if (s.replacedById) {
        await revokeFamily(tx, s.familyId)
        await audit(tx, {
          actorId: s.userId,
          action: 'REFRESH_TOKEN_REUSE',
          entity: 'session',
          entityId: s.id,
          metadata: { familyId: s.familyId },
          ip: meta.ip,
        })
      }
      return { ok: false as const }
    }
    if (s.expiresAt <= new Date()) return { ok: false as const }

    const [user] = await tx.select().from(users).where(eq(users.id, s.userId))
    if (!user || user.status !== 'ACTIVE') {
      await revokeFamily(tx, s.familyId)
      return { ok: false as const }
    }

    const next = await createSession(ctx, tx, user.id, meta, s.familyId)
    await tx.update(sessions).set({ revokedAt: new Date(), replacedById: next.sessionId }).where(eq(sessions.id, s.id))
    return { ok: true as const, user, next }
  })

  if (!outcome.ok) {
    if ('race' in outcome) {
      throw new AppError(409, 'REFRESH_RACE', 'A sessão acabou de ser renovada em outra requisição. Tente novamente.')
    }
    throw invalidRefresh()
  }
  return buildAuthResult(ctx, outcome.user, outcome.next)
}

export async function logout(ctx: AppContext, rawToken: string | undefined) {
  if (!rawToken || rawToken.length > 200) return
  const [s] = await ctx.db
    .select({ familyId: sessions.familyId })
    .from(sessions)
    .where(eq(sessions.tokenHash, sha256(rawToken)))
    .limit(1)
  if (s) await revokeFamily(ctx.db, s.familyId)
}

export async function logoutAll(ctx: AppContext, userId: string, meta: RequestMeta) {
  await revokeAllSessions(ctx.db, userId)
  await audit(ctx.db, { actorId: userId, action: 'LOGOUT_ALL', entity: 'user', entityId: userId, ip: meta.ip })
}

export async function getMe(ctx: AppContext, userId: string) {
  const [user] = await ctx.db.select().from(users).where(eq(users.id, userId))
  if (!user) throw unauthorized()
  return toMe(user)
}

export async function verifyEmail(ctx: AppContext, token: string, meta: RequestMeta) {
  const cfg = await ctx.settings.get()
  const ok = await ctx.db.transaction(async (tx) => {
    const row = await consumeAuthToken(tx, token, 'EMAIL_VERIFY')
    if (!row) return false
    const [user] = await tx.select().from(users).where(eq(users.id, row.userId)).for('update')
    if (!user || user.status === 'DELETED') return false
    if (user.emailVerifiedAt) return true

    await tx.update(users).set({ emailVerifiedAt: new Date() }).where(eq(users.id, user.id))
    // Bônus de indicação só após o indicado confirmar o e-mail (reduz abuso com contas falsas).
    if (user.referredById && cfg.referralBonusCents > 0) {
      await applyWalletMovement(tx, {
        userId: user.referredById,
        amountCents: cfg.referralBonusCents,
        type: 'REFERRAL',
        referenceType: 'user',
        referenceId: user.id,
        reason: 'Indicação confirmada',
      })
    }
    await audit(tx, { actorId: user.id, action: 'EMAIL_VERIFIED', entity: 'user', entityId: user.id, ip: meta.ip })
    return true
  })
  if (!ok) throw badRequest('Link de verificação inválido ou expirado.', 'INVALID_TOKEN')
}

export async function resendVerification(ctx: AppContext, userId: string) {
  const [user] = await ctx.db.select().from(users).where(eq(users.id, userId))
  if (!user) throw unauthorized()
  if (user.emailVerifiedAt) throw conflict('Seu e-mail já está confirmado.', 'ALREADY_VERIFIED')
  await sendVerification(ctx, user)
}

/** Sempre silencioso para o cliente: não revela se o e-mail existe. */
export async function forgotPassword(ctx: AppContext, email: string, meta: RequestMeta) {
  const [user] = await ctx.db
    .select({ id: users.id, email: users.email, status: users.status })
    .from(users)
    .where(eq(users.emailHash, emailIndex(email)))
    .limit(1)
  if (!user || user.status !== 'ACTIVE') {
    // Mesmo trabalho de banco (1 audit) do caminho "existe" e sem e-mail: tempo equivalente (QA-08).
    await audit(ctx.db, {
      action: 'PASSWORD_RESET_REQUESTED',
      entity: 'auth',
      metadata: { emailRef: emailIndex(email).slice(0, 16), known: false },
      ip: meta.ip,
    })
    return
  }
  const token = await issueAuthToken(ctx.db, user.id, 'PASSWORD_RESET', PASSWORD_RESET_TTL_MS)
  await audit(ctx.db, {
    actorId: user.id,
    action: 'PASSWORD_RESET_REQUESTED',
    entity: 'user',
    entityId: user.id,
    ip: meta.ip,
  })
  // Envio fora do ciclo da requisição: a latência do provedor de e-mail não revela se a conta existe.
  sendInBackground(ctx, {
    to: user.email,
    kind: 'PASSWORD_RESET',
    subject: 'Redefinição de senha do VibeGet',
    link: `${ctx.env.APP_URL}/redefinir-senha?token=${encodeURIComponent(token)}`,
    token,
  })
}

function sendInBackground(ctx: AppContext, mail: Parameters<AppContext['mailer']['send']>[0]) {
  ctx.mailer.send(mail).catch((err: unknown) => {
    ctx.log.error({ kind: mail.kind, error: err instanceof Error ? err.name : 'Error' }, 'falha ao enviar e-mail')
  })
}

export async function resetPassword(ctx: AppContext, token: string, password: string, meta: RequestMeta) {
  const passwordHash = await hashPassword(password)
  const ok = await ctx.db.transaction(async (tx) => {
    const row = await consumeAuthToken(tx, token, 'PASSWORD_RESET')
    if (!row) return false
    const [user] = await tx.select({ status: users.status }).from(users).where(eq(users.id, row.userId))
    if (!user || user.status === 'DELETED') return false
    await tx
      .update(users)
      .set({ passwordHash, failedLoginCount: 0, lockedUntil: null })
      .where(eq(users.id, row.userId))
    await revokeAllSessions(tx, row.userId)
    await audit(tx, { actorId: row.userId, action: 'PASSWORD_RESET', entity: 'user', entityId: row.userId, ip: meta.ip })
    return true
  })
  if (!ok) throw badRequest('Link de redefinição inválido ou expirado.', 'INVALID_TOKEN')
}

/** Troca de senha: revoga todas as sessões e devolve uma sessão nova para o dispositivo atual. */
export async function changePassword(
  ctx: AppContext,
  userId: string,
  input: { currentPassword: string; newPassword: string },
  meta: RequestMeta,
): Promise<AuthResult> {
  const [user] = await ctx.db.select().from(users).where(eq(users.id, userId))
  if (!user) throw unauthorized()
  // Falhas aqui contam no mesmo limite do login (QA-10).
  const reserved = await reservePasswordAttempt(ctx.db, userId)
  if (reserved === null) throw tooManyAttempts()
  if (!(await verifyPassword(user.passwordHash, input.currentPassword))) {
    const locked = await registerFailedAttempt(ctx.db, userId, reserved)
    await audit(ctx.db, {
      actorId: userId,
      action: locked ? 'ACCOUNT_LOCKED' : 'PASSWORD_CHANGE_FAILED',
      entity: 'user',
      entityId: userId,
      metadata: { reason: 'bad_password', flow: 'change_password' },
      ip: meta.ip,
    })
    throw badRequest('Senha atual incorreta.', 'INVALID_PASSWORD')
  }
  await clearPasswordAttempts(ctx.db, userId)
  if (input.newPassword.toLowerCase() === user.email) {
    throw badRequest('A senha não pode ser igual ao e-mail.', 'WEAK_PASSWORD')
  }
  const passwordHash = await hashPassword(input.newPassword)
  const session = await ctx.db.transaction(async (tx) => {
    await tx.update(users).set({ passwordHash }).where(eq(users.id, userId))
    await revokeAllSessions(tx, userId)
    await tx.delete(authTokens).where(and(eq(authTokens.userId, userId), eq(authTokens.type, 'PASSWORD_RESET')))
    await audit(tx, { actorId: userId, action: 'PASSWORD_CHANGED', entity: 'user', entityId: userId, ip: meta.ip })
    return createSession(ctx, tx, userId, meta)
  })
  return buildAuthResult(ctx, user, session)
}
