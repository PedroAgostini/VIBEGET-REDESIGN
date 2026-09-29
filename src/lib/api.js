// Cliente da API do VibeGet (server/). O access token vive só em memória;
// a sessão sobrevive a recarregamentos pelo cookie httpOnly de refresh.
const BASE = '/api/v1'

let accessToken = null
let refreshing = null
const listeners = new Set()

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message)
    this.status = status
    this.code = code
    this.details = details
  }
}

export function onSessionChange(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function setSession(token, user) {
  accessToken = token
  listeners.forEach((fn) => fn(user))
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function raw(path, { method = 'GET', body, auth = false, headers: extra } = {}) {
  const headers = { 'X-Requested-With': 'fetch', ...extra }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (auth && accessToken) headers.Authorization = `Bearer ${accessToken}`
  let res
  try {
    res = await fetch(BASE + path, {
      method,
      headers,
      credentials: 'include',
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    throw new ApiError(0, 'NETWORK', 'Sem conexão com o servidor. Confira sua internet e tente de novo.')
  }
  if (res.status === 204) return null
  const data = await res.json().catch(() => null)
  if (!res.ok) {
    const e = data?.error
    throw new ApiError(res.status, e?.code ?? 'UNKNOWN', e?.message ?? 'Algo deu errado. Tente de novo.', e?.details)
  }
  return data
}

// Uma renovação por vez; se outra aba renovou no mesmo instante (409 REFRESH_RACE),
// o cookie novo já chegou e basta repetir uma vez.
export function refreshSession() {
  if (!refreshing) {
    refreshing = (async () => {
      try {
        const data = await raw('/auth/refresh', { method: 'POST' }).catch(async (err) => {
          if (err.code !== 'REFRESH_RACE') throw err
          await sleep(250)
          return raw('/auth/refresh', { method: 'POST' })
        })
        setSession(data.accessToken, data.user)
        return data.user
      } catch (err) {
        setSession(null, null)
        throw err
      } finally {
        refreshing = null
      }
    })()
  }
  return refreshing
}

/** Chamada autenticada: com 401 (token vencido), renova a sessão uma vez e repete. */
export async function api(path, options = {}) {
  try {
    return await raw(path, { ...options, auth: true })
  } catch (err) {
    if (err.status !== 401) throw err
    await refreshSession()
    return raw(path, { ...options, auth: true })
  }
}

export async function login(input) {
  const data = await raw('/auth/login', { method: 'POST', body: input })
  setSession(data.accessToken, data.user)
  return data
}

export async function register(input) {
  const data = await raw('/auth/register', { method: 'POST', body: input })
  setSession(data.accessToken, data.user)
  return data
}

export async function logout() {
  try {
    await raw('/auth/logout', { method: 'POST' })
  } finally {
    setSession(null, null)
  }
}

export const publicPost = (path, body) => raw(path, { method: 'POST', body })

/** Chave de idempotência para operações com dinheiro (repetir a mesma chave não duplica). */
export const newIdempotencyKey = () => crypto.randomUUID()

/** Erros de validação do servidor ({ path, message }[]) viram um mapa campo → mensagem. */
export function fieldErrors(err) {
  if (!Array.isArray(err?.details)) return {}
  return Object.fromEntries(err.details.filter((d) => d.path).map((d) => [d.path, d.message]))
}

/** Atualiza o usuário em memória (ex.: depois de editar o perfil) sem mexer no token. */
export function updateUser(user) {
  listeners.forEach((fn) => fn(user))
}

export const coins = (cents) =>
  (cents / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export const brl = (cents) =>
  (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
