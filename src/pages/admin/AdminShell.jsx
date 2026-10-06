import { motion, MotionConfig } from 'framer-motion'
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom'
import { ArrowSquareOut, ChartLineUp, Coins, Gavel, GearSix, Money, Package, PlusCircle, ShieldCheck, Ticket, Users } from '@phosphor-icons/react'
import UserChip from '../../components/UserChip.jsx'
import { useApi } from '../../lib/useApi.js'
import { useAuth } from '../../lib/auth.jsx'

const ease = [0.16, 1, 0.3, 1]

const GROUPS = [
  ['Operação', [
    { to: '/admin', end: true, label: 'Visão geral', Icon: ChartLineUp },
    { to: '/admin/saques', label: 'Saques', Icon: Money, badge: (p) => p?.withdrawals.count },
    { to: '/admin/entregas', label: 'Entregas', Icon: Package, badge: (p) => p?.prizesToShip },
    { to: '/admin/usuarios', label: 'Usuários', Icon: Users },
  ]],
  ['Catálogo', [
    { to: '/admin/vibes', label: 'Vibes', Icon: Gavel, match: (path) => path.startsWith('/admin/vibes') && path !== '/admin/vibes/nova' },
    { to: '/admin/vibes/nova', label: 'Novo leilão', Icon: PlusCircle, adminOnly: true },
    { to: '/admin/cupons', label: 'Cupons', Icon: Ticket },
    { to: '/admin/pacotes', label: 'Pacotes', Icon: Coins, adminOnly: true },
  ]],
  ['Sistema', [
    { to: '/admin/configuracoes', label: 'Configurações', Icon: GearSix, adminOnly: true },
  ]],
]

export default function AdminShell() {
  const { pathname } = useLocation()
  const { user } = useAuth()
  const isAdmin = user?.role === 'ADMIN'
  const dash = useApi('/admin/dashboard')
  const pending = dash.data?.data?.pending
  const isActive = (item) => (item.match ? item.match(pathname) : item.end ? pathname === item.to : pathname.startsWith(item.to))

  return (
    <MotionConfig reducedMotion="user">
      <div className="ad">
        <div className="atmos" aria-hidden="true" />

        <header className="ad-top">
          <Link to="/admin" className="auth-brand ad-brand" aria-label="Painel VibeGet, visão geral">
            <img src="/img/logo.png" alt="VibeGet" />
            <span className="ad-tag">Painel</span>
          </Link>
          <div className="ad-top-right">
            <Link to="/" className="ad-site-link">Ver o site<ArrowSquareOut size={16} aria-hidden="true" /></Link>
            <UserChip afterLogout="/login" />
          </div>
        </header>

        <div className="ad-body">
          <aside className="ad-side">
            <nav className="ad-nav" aria-label="Painel administrativo">
              {GROUPS.map(([title, items]) => [title, items.filter((i) => !i.adminOnly || isAdmin)]).filter(([, items]) => items.length > 0).map(([title, items]) => (
                <div key={title} className="ad-nav-group">
                  <p className="ad-nav-title">{title}</p>
                  <ul>
                    {items.map((item) => {
                      const n = item.badge?.(pending)
                      const active = isActive(item)
                      return (
                        <li key={item.to}>
                          <NavLink to={item.to} end className={`ad-nav-link ${active ? 'is-active' : ''}`} aria-current={active ? 'page' : undefined}>
                            {active && <motion.span layoutId="ad-nav-pill" className="ad-nav-pill" transition={{ duration: 0.4, ease }} />}
                            <item.Icon size={20} className="ad-nav-icon" aria-hidden="true" />
                            <span className="ad-nav-label">{item.label}</span>
                            {n > 0 && <span className="mono ad-nav-badge" aria-label={`${n} pendentes`}>{n}</span>}
                          </NavLink>
                        </li>
                      )
                    })}
                  </ul>
                </div>
              ))}
            </nav>
            <div className="ad-role glass">
              <ShieldCheck size={20} weight="duotone" aria-hidden="true" />
              <div>
                <p className="ad-role-name">{isAdmin ? 'Administrador' : 'Suporte'}</p>
                <p className="ad-role-help">{isAdmin ? 'Acesso completo às ações' : 'Só leitura: sem ações'}</p>
              </div>
            </div>
          </aside>

          <main className="ad-main" id="main">
            <Outlet context={{ dashboard: dash }} />
          </main>
        </div>
      </div>
    </MotionConfig>
  )
}
