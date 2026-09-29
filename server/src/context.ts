import type { FastifyBaseLogger } from 'fastify'
import type { Env } from './config/env.js'
import type { Db } from './db/client.js'
import type { Mailer } from './lib/mailer.js'
import type { SettingsStore } from './lib/settings.js'
import type { Role } from './db/schema.js'

export interface AccessTokenPayload {
  sub: string
  /** family_id da sessão de refresh; permite revogar access tokens junto com a sessão. */
  sid: string
  role: Role
}

/** Dependências compartilhadas pelos services (injeção simples, facilita testes). */
export interface AppContext {
  db: Db
  env: Env
  mailer: Mailer
  /** D3: configurações do ADMIN (cache curto). */
  settings: SettingsStore
  /** HTTP de saída (proxy de CEP). Injetável para testes. */
  fetch: (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>
  log: FastifyBaseLogger
  signAccessToken: (payload: AccessTokenPayload) => string
}

export interface AuthInfo {
  userId: string
  role: Role
  sessionFamilyId: string
}

export interface RequestMeta {
  ip: string
  userAgent: string | null
  /** Momento em que a requisição chegou (ms). Usado para distinguir corrida de reuso no refresh. */
  receivedAt?: number
}

declare module 'fastify' {
  interface FastifyInstance {
    ctx: AppContext
  }
  interface FastifyRequest {
    auth: AuthInfo | null
    receivedAt: number
  }
}
