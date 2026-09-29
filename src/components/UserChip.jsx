import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Link, useNavigate } from 'react-router-dom'
import { CaretDown, House, SignOut, UserCircle, Wallet } from '@phosphor-icons/react'
import { logout } from '../lib/api.js'
import { useAuth } from '../lib/auth.jsx'
import { levelOf } from '../lib/levels.js'

const ease = [0.16, 1, 0.3, 1]

const ITEMS = [
  { to: '/dashboard', label: 'Minha área', Icon: House },
  { to: '/dashboard/carteira', label: 'Carteira', Icon: Wallet },
  { to: '/dashboard/conta', label: 'Minha conta', Icon: UserCircle },
]

/** Iniciais do primeiro e do último nome ("Pedro Agostini" → "PA"). */
function initialsOf(name = '') {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase()
}

/**
 * Cartão da conta logada, usado na home e no dashboard: avatar cunhado como uma GetCoin com as iniciais,
 * selo do nível, primeiro nome e nível. Abre um menu com atalhos da área logada e Sair.
 */
export default function UserChip({ afterLogout = '/' }) {
  const { user } = useAuth()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const wrapRef = useRef(null)
  const buttonRef = useRef(null)

  // Fecha ao clicar fora ou com Esc (devolvendo o foco ao botão).
  useEffect(() => {
    if (!open) return
    const onDown = (e) => { if (!wrapRef.current?.contains(e.target)) setOpen(false) }
    const onKey = (e) => {
      if (e.key !== 'Escape') return
      setOpen(false)
      buttonRef.current?.focus()
    }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (!user) return null
  const level = levelOf(user.level)
  const firstName = user.name.split(' ')[0]

  async function signOut() {
    setLeaving(true)
    await logout().catch(() => {})
    setOpen(false)
    setLeaving(false)
    navigate(afterLogout, { replace: true })
  }

  return (
    <div className="uc" ref={wrapRef}>
      <button
        ref={buttonRef}
        type="button"
        className={`uc-chip ${open ? 'is-open' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls="uc-menu"
        aria-label={`Conta de ${user.name}, nível ${level.n}, ${level.label}`}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="uc-avatar" aria-hidden="true">
          {/* Mesma cunhagem da GetCoin (components/Coin.jsx), com as iniciais no lugar do raio */}
          <svg viewBox="0 0 64 64" width="40" height="40" focusable="false">
            <circle cx="32" cy="32" r="31" fill="#b9551a" />
            <circle cx="32" cy="32" r="28" fill="#eaad53" />
            <circle cx="32" cy="32" r="21.5" fill="none" stroke="#6e2d0b" strokeWidth="1.6" />
            <text x="32" y="32.5" className="uc-initials" textAnchor="middle" dominantBaseline="central">{initialsOf(user.name)}</text>
          </svg>
          <span className="uc-badge mono">{level.n}</span>
        </span>
        <span className="uc-text" aria-hidden="true">
          <span className="uc-name">{firstName}</span>
          <span className="uc-level">{level.label}</span>
        </span>
        <CaretDown size={14} weight="bold" className="uc-caret" aria-hidden="true" />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            id="uc-menu"
            className="uc-menu glass"
            role="menu"
            aria-label="Conta"
            initial={{ opacity: 0, y: -6, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.97 }}
            transition={{ duration: 0.22, ease }}
          >
            <div className="uc-menu-head">
              <span className="uc-menu-name">{user.name}</span>
              <span className="uc-menu-email" title={user.email}>{user.email}</span>
              <span className="uc-menu-level">Nível <span className="mono">{level.n}</span> · {level.label}</span>
            </div>
            {ITEMS.map(({ to, label, Icon }) => (
              <Link key={to} to={to} role="menuitem" className="uc-item" onClick={() => setOpen(false)}>
                <Icon size={18} aria-hidden="true" />{label}
              </Link>
            ))}
            <button type="button" role="menuitem" className="uc-item uc-item-out" onClick={signOut} disabled={leaving}>
              <SignOut size={18} aria-hidden="true" />{leaving ? 'Saindo…' : 'Sair'}
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
