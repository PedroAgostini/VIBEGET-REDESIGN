import { createContext, useContext, useEffect, useState } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { onSessionChange, refreshSession } from './api.js'

const AuthContext = createContext(null)

// status: 'loading' até a primeira tentativa de restaurar a sessão pelo cookie.
export function AuthProvider({ children }) {
  const [state, setState] = useState({ status: 'loading', user: null })

  useEffect(() => {
    const off = onSessionChange((user) => setState({ status: user ? 'authed' : 'guest', user }))
    refreshSession().catch(() => setState({ status: 'guest', user: null }))
    return off
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

/** Rota de destino segura: só caminhos internos, nunca "//host" ou URL absoluta. */
export function safeNext(value, fallback = '/dashboard') {
  return value && value.startsWith('/') && !value.startsWith('//') ? value : fallback
}
