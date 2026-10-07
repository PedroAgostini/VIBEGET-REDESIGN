import { motion, MotionConfig } from 'framer-motion'
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom'
import { Coins, Gavel, House, Storefront, UserCircle, Wallet } from '@phosphor-icons/react'
import UserChip from '../../components/UserChip.jsx'

const ease = [0.16, 1, 0.3, 1]

const NAV = [
  { to: '/dashboard', end: true, label: 'Início', Icon: House },
  { to: '/dashboard/gets', label: 'Meus Gets', Icon: Gavel },
  { to: '/dashboard/carteira', label: 'Carteira', Icon: Wallet },
  { to: '/dashboard/comprar', label: 'Comprar GetCoins', short: 'Comprar', Icon: Coins },
  { to: '/dashboard/marketplace', label: 'Marketplace', short: 'Mercado', Icon: Storefront },
  { to: '/dashboard/conta', label: 'Minha conta', short: 'Conta', Icon: UserCircle },
]

export default function Shell() {
  const { pathname } = useLocation()

  const isActive = (item) => (item.end ? pathname === item.to : pathname.startsWith(item.to))

  return (
    <MotionConfig reducedMotion="user">
      <div className="dash">
        <div className="atmos" aria-hidden="true" />
        <div className="dash-art" aria-hidden="true"><img src="/img/hero-bg.svg" alt="" /></div>

        <header className="dash-top">
          <Link to="/" className="auth-brand" aria-label="VibeGet, ir para o início do site">
            <img src="/img/logo.png" alt="VibeGet" />
          </Link>
          <div className="dash-top-right">
            <UserChip afterLogout="/login" />
          </div>
        </header>

        <nav className="dash-nav" aria-label="Minha área">
          <ul>
            {NAV.map((item) => (
              <li key={item.to}>
                <NavLink to={item.to} end={item.end} className="dash-nav-link">
                  {isActive(item) && (
                    <motion.span layoutId="dash-nav-pill" className="dash-nav-pill" transition={{ duration: 0.45, ease }} />
                  )}
                  <item.Icon size={20} className="dash-nav-icon" aria-hidden="true" />
                  <span className="dash-nav-label">
                    <span className="dash-nav-full">{item.label}</span>
                    <span className="dash-nav-short">{item.short ?? item.label}</span>
                  </span>
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>

        <main className="dash-main" id="main">
          <Outlet />
        </main>
      </div>
    </MotionConfig>
  )
}
