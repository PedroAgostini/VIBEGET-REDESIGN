import { eq } from 'drizzle-orm'
import { z } from 'zod'
import type { AppContext, RequestMeta } from '../../context.js'
import { users } from '../../db/schema.js'
import { audit } from '../../lib/audit.js'
import { AppError, notFound, unauthorized } from '../../lib/errors.js'
import { toMe } from '../../lib/presenters.js'

export const UFS = [
  'AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG', 'PA',
  'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO',
] as const

export const cepSchema = z
  .string()
  .transform((v) => v.replace(/\D/g, ''))
  .refine((v) => /^\d{8}$/.test(v), 'CEP deve ter 8 dígitos.')

export const addressSchema = z
  .object({
    cep: cepSchema,
    street: z.string().trim().min(2).max(160),
    number: z.string().trim().min(1, 'Informe o número.').max(20),
    complement: z.string().trim().max(80).nullable().optional(),
    district: z.string().trim().min(1).max(100),
    city: z.string().trim().min(2).max(100),
    state: z.string().trim().toUpperCase().pipe(z.enum(UFS, { message: 'UF inválida.' })),
  })
  .strict()

export async function putAddress(ctx: AppContext, userId: string, input: z.output<typeof addressSchema>, meta: RequestMeta) {
  const [u] = await ctx.db
    .update(users)
    .set({ ...input, complement: input.complement || null })
    .where(eq(users.id, userId))
    .returning()
  if (!u) throw unauthorized()
  await audit(ctx.db, { actorId: userId, action: 'ADDRESS_UPDATED', entity: 'user', entityId: userId, ip: meta.ip })
  return toMe(u)
}

// ---------- CEP (proxy ViaCEP -> BrasilAPI, cache 24 h) ----------

export interface CepResult {
  cep: string
  street: string
  district: string
  city: string
  state: string
}

const TTL_OK_MS = 24 * 60 * 60 * 1000
const TTL_MISS_MS = 60 * 60 * 1000
const MAX_ENTRIES = 5000
const cache = new Map<string, { at: number; value: CepResult | null }>()

type FetchLike = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{
  ok: boolean
  status: number
  json: () => Promise<unknown>
}>

async function getJson(fetchImpl: FetchLike, url: string) {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(3000), headers: { accept: 'application/json' } })
  return { status: res.status, ok: res.ok, body: res.ok || res.status === 404 ? await res.json().catch(() => null) : null }
}

const str = (v: unknown) => (typeof v === 'string' ? v : '')

/** undefined = provedor falhou (tenta o próximo); null = CEP inexistente. */
async function viaCep(f: FetchLike, cep: string): Promise<CepResult | null | undefined> {
  const r = await getJson(f, `https://viacep.com.br/ws/${cep}/json/`)
  if (!r.ok || !r.body || typeof r.body !== 'object') return undefined
  const b = r.body as Record<string, unknown>
  if (b.erro === true || b.erro === 'true') return null
  return { cep, street: str(b.logradouro), district: str(b.bairro), city: str(b.localidade), state: str(b.uf) }
}

async function brasilApi(f: FetchLike, cep: string): Promise<CepResult | null | undefined> {
  const r = await getJson(f, `https://brasilapi.com.br/api/cep/v1/${cep}`)
  if (r.status === 404) return null
  if (!r.ok || !r.body || typeof r.body !== 'object') return undefined
  const b = r.body as Record<string, unknown>
  return { cep, street: str(b.street), district: str(b.neighborhood), city: str(b.city), state: str(b.state) }
}

export async function lookupCep(fetchImpl: FetchLike, cep: string): Promise<CepResult> {
  const hit = cache.get(cep)
  if (hit && Date.now() - hit.at < (hit.value ? TTL_OK_MS : TTL_MISS_MS)) {
    if (!hit.value) throw notFound('CEP não encontrado.', 'CEP_NOT_FOUND')
    return hit.value
  }
  let value: CepResult | null | undefined
  for (const provider of [viaCep, brasilApi]) {
    try {
      value = await provider(fetchImpl, cep)
    } catch {
      value = undefined
    }
    if (value !== undefined) break
  }
  if (value === undefined) throw new AppError(503, 'CEP_UNAVAILABLE', 'Serviço de CEP indisponível. Preencha o endereço manualmente.')
  if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value!)
  cache.set(cep, { at: Date.now(), value })
  if (!value) throw notFound('CEP não encontrado.', 'CEP_NOT_FOUND')
  return value
}

/** Testes: limpa o cache em memória. */
export function clearCepCache() {
  cache.clear()
}
