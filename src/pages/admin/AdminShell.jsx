import { motion, MotionConfig } from 'framer-motion'
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom'
import { ArrowSquareOut, ChartLineUp, Gavel, Money, Package } from '@phosphor-icons/react'
import UserChip from '../../components/UserChip.jsx'
import { useApi } from '../../lib/useApi.js'

const ease = [0.16, 1, 0.3, 1]

const NAV = [
  { to: '/admin', end: true, label: 'Visão geral', Icon: ChartLineUp },
  { to: '/admin/saques', label: 'Saques', Icon: Money, badge: (p) => p?.withdrawals.count },
  { to: '/admin/entregas', label: 'Entregas', Icon: Package, badge: (p) => p?.prizesToShip },
  { to: '/admin/vibes', label: 'Vibes', Icon: Gavel },
]

export default function AdminShell() {
  const { pathname } = useLocation()
  const dash = useApi('/admin/dashboard')
  const pending = dash.data?.data?.pending
  const isActive = (item) => (item.end ? pathname === item.to : pathname.startsWith(item.to))

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
          <nav className="ad-nav" aria-label="Painel administrativo">
            <ul>
              {NAV.map((item) => {
                const n = item.badge?.(pending)
                return (
                  <li key={item.to}>
                    <NavLink to={item.to} end={item.end} className="ad-nav-link">
                      {isActive(item) && <motion.span layoutId="ad-nav-pill" className="ad-nav-pill" transition={{ duration: 0.4, ease }} />}
                      <item.Icon size={20} className="ad-nav-icon" aria-hidden="true" />
                      <span className="ad-nav-label">{item.label}</span>
                      {n > 0 && <span className="mono ad-nav-badge" aria-label={`${n} pendentes`}>{n}</span>}
                    </NavLink>
                  </li>
                )
              })}
            </ul>
          </nav>

          <main className="ad-main" id="main">
            <Outlet context={{ dashboard: dash }} />
          </main>
        </div>
      </div>
    </MotionConfig>
  )
}
