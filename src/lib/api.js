// Cliente da API do VibeGet (server/). O access token vive só em memória;
// a sessão sobrevive a recarregamentos pelo cookie httpOnly de refresh.
const BASE = '/api/v1'

let accessToken = null
let currentUser = null
let refreshing = null
const listeners = new Set()

// Abas do mesmo navegador dividem o cookie de refresh: uma renova por vez (Web Locks)
// e avisa as outras pelo canal, que reaproveitam o token em vez de renovar de novo.
const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('vibeget-session') : null
let sharedAt = 0
channel?.addEventListener('message', ({ data }) => {
  sharedAt = Date.now()
  setSession(data?.token ?? null, data?.user ?? null)
})
const withRefreshLock = (fn) => (navigator.locks ? navigator.locks.request('vibeget-refresh', fn) : fn())

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

function setSession(token, user, { share = false } = {}) {
  accessToken = token
  currentUser = user
  listeners.forEach((fn) => fn(user))
  if (share) channel?.postMessage({ token, user })
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

// Uma renovação por vez entre todas as abas. Se outra aba renovou enquanto esta esperava a vez,
// usa o token que ela compartilhou. 409 REFRESH_RACE (navegador sem Web Locks): o cookie novo já chegou, repete uma vez.
export function refreshSession() {
  if (!refreshing) {
    const askedAt = Date.now()
    refreshing = withRefreshLock(async () => {
      if (sharedAt >= askedAt && accessToken) return currentUser
      const data = await raw('/auth/refresh', { method: 'POST' }).catch(async (err) => {
        if (err.code !== 'REFRESH_RACE') throw err
        await sleep(250)
        return raw('/auth/refresh', { method: 'POST' })
      })
      setSession(data.accessToken, data.user, { share: true })
      return data.user
    })
      .catch((err) => {
        setSession(null, null)
        throw err
      })
      .finally(() => {
        refreshing = null
      })
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

/** Envia um arquivo (multipart) com a mesma autenticação e renovação de sessão de api(). */
export async function upload(path, file) {
  const send = async () => {
    const form = new FormData()
    form.append('file', file)
    let res
    try {
      res = await fetch(BASE + path, {
        method: 'POST',
        headers: { 'X-Requested-With': 'fetch', ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}) },
        credentials: 'include',
        body: form,
      })
    } catch {
      throw new ApiError(0, 'NETWORK', 'Sem conexão com o servidor. Confira sua internet e tente de novo.')
    }
    const data = await res.json().catch(() => null)
    if (!res.ok) {
      const e = data?.error
      throw new ApiError(res.status, e?.code ?? 'UNKNOWN', e?.message ?? 'Não foi possível enviar o arquivo.', e?.details)
    }
    return data
  }
  try {
    return await send()
  } catch (err) {
    if (err.status !== 401) throw err
    await refreshSession()
    return send()
  }
}

export async function login(input) {
  const data = await raw('/auth/login', { method: 'POST', body: input })
  setSession(data.accessToken, data.user, { share: true })
  return data
}

export async function register(input) {
  const data = await raw('/auth/register', { method: 'POST', body: input })
  setSession(data.accessToken, data.user, { share: true })
  return data
}

export async function logout() {
  try {
    await raw('/auth/logout', { method: 'POST' })
  } finally {
    setSession(null, null, { share: true })
  }
}

/** Encerra todas as sessões da conta, em qualquer aparelho. */
export async function logoutAll() {
  await api('/auth/logout-all', { method: 'POST' })
  setSession(null, null, { share: true })
}

/** LGPD: exclui (anonimiza) a conta. A API recusa com 409 se houver saldo, anúncio ou Get em aberto. */
export async function deleteAccount(password) {
  await api('/me', { method: 'DELETE', body: { password } })
  setSession(null, null, { share: true })
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
  setSession(accessToken, user, { share: true })
}

export const coins = (cents) =>
  (cents / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export const brl = (cents) =>
  (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
