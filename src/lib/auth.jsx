import { createContext, useContext, useEffect, useState } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { isTransient, onSessionChange, refreshSession } from './api.js'

const AuthContext = createContext(null)

// status: 'loading' até a primeira tentativa de restaurar a sessão pelo cookie.
export function AuthProvider({ children }) {
  const [state, setState] = useState({ status: 'loading', user: null })

  useEffect(() => {
    const off = onSessionChange((user) => setState({ status: user ? 'authed' : 'guest', user }))
    // Se o servidor estiver fora do ar por instantes (deploy, reinício), tenta de novo antes de tratar como deslogado.
    let timer
    let alive = true
    const restore = (attempt = 0) =>
      refreshSession().catch((err) => {
        if (!alive) return
        if (isTransient(err) && attempt < 6) timer = setTimeout(() => restore(attempt + 1), Math.min(1000 * 2 ** attempt, 15000))
        else setState({ status: 'guest', user: null })
      })
    restore()
    return () => {
      alive = false
      clearTimeout(timer)
      off()
    }
  }, [])

  return <AuthContext.Provider value={state}>{children}</AuthContext.Provider>
}

export const useAuth = () => useContext(AuthContext)

/** Só renderiza para quem está logado; os outros vão para /login e voltam depois. */
export function RequireAuth({ children }) {
  const { status } = useAuth()
  const location = useLocation()
  if (status === 'loading') return null
  if (status === 'guest') {
    return <Navigate to={`/login?next=${encodeURIComponent(location.pathname)}`} replace />
  }
  return children
}

export const isStaff = (user) => user?.role === 'ADMIN' || user?.role === 'SUPPORT'

/** Painel /admin: SUPPORT e ADMIN. Quem não é da equipe volta para a própria área. A API também confere o papel. */
export function RequireStaff({ children }) {
  const { status, user } = useAuth()
  const location = useLocation()
  if (status === 'loading') return null
  if (status === 'guest') return <Navigate to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`} replace />
  if (!isStaff(user)) return <Navigate to="/dashboard" replace />
  return children
}

/**
 * Rota de destino segura: só caminhos internos. Recusa "//host", URL absoluta e os desvios clássicos
 * de open redirect ("/\host", barras invertidas e caracteres de controle, que o navegador normaliza).
 */
export function safeNext(value, fallback = '/dashboard') {
  if (typeof value !== 'string' || value.length > 512) return fallback
  if (!/^\/(?![/\\])/.test(value) || /[\\\u0000-\u001f\u007f]/.test(value)) return fallback
  return value
}
