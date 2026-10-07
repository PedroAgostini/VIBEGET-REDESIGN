import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/bricolage-grotesque/wdth.css'
import '@fontsource-variable/onest'
import '@fontsource-variable/martian-mono'
import '@fontsource/instrument-serif/400.css'
import '@fontsource/instrument-serif/400-italic.css'
import './styles.css'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import App from './App.jsx'
import Auth from './pages/Auth.jsx'
import VibesPage from './pages/Vibes.jsx'
import VibePage from './pages/Vibe.jsx'
import Shell from './pages/dashboard/Shell.jsx'
import Home from './pages/dashboard/Home.jsx'
import Account from './pages/dashboard/Account.jsx'
import Gets from './pages/dashboard/Gets.jsx'
import Wallet from './pages/dashboard/Wallet.jsx'
import Buy from './pages/dashboard/Buy.jsx'
import Market from './pages/dashboard/Market.jsx'
import AdminShell from './pages/admin/AdminShell.jsx'
import Overview from './pages/admin/Overview.jsx'
import Withdrawals from './pages/admin/Withdrawals.jsx'
import Deliveries from './pages/admin/Deliveries.jsx'
import AdminVibes from './pages/admin/AdminVibes.jsx'
import NewAuction from './pages/admin/NewAuction.jsx'
import Users from './pages/admin/Users.jsx'
import UserDetail from './pages/admin/UserDetail.jsx'
import Settings from './pages/admin/Settings.jsx'
import Coupons from './pages/admin/Coupons.jsx'
import Packages from './pages/admin/Packages.jsx'
import EditAuction from './pages/admin/EditAuction.jsx'
import AdminMarket from './pages/admin/AdminMarket.jsx'
import Audit from './pages/admin/Audit.jsx'
import { AuthProvider, RequireAuth, RequireStaff } from './lib/auth.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/" element={<App />} />
          <Route path="/vibes" element={<VibesPage />} />
          <Route path="/vibes/:slug" element={<VibePage />} />
          <Route path="/leiloes" element={<Navigate to="/vibes" replace />} />
          <Route path="/login" element={<Auth view="login" />} />
          <Route path="/cadastro" element={<Auth view="cadastro" />} />
          <Route path="/redefinir-senha" element={<Auth view="redefinir" />} />
          <Route path="/verificar-email" element={<Auth view="verificar" />} />
          <Route path="/dashboard" element={<RequireAuth><Shell /></RequireAuth>}>
            <Route index element={<Home />} />
            <Route path="gets" element={<Gets />} />
            <Route path="carteira" element={<Wallet />} />
            <Route path="comprar" element={<Buy />} />
            <Route path="marketplace" element={<Market />} />
            <Route path="conta" element={<Account />} />
          </Route>
          <Route path="/admin" element={<RequireStaff><AdminShell /></RequireStaff>}>
            <Route index element={<Overview />} />
            <Route path="saques" element={<Withdrawals />} />
            <Route path="entregas" element={<Deliveries />} />
            <Route path="usuarios" element={<Users />} />
            <Route path="usuarios/:id" element={<UserDetail />} />
            <Route path="configuracoes" element={<Settings />} />
            <Route path="cupons" element={<Coupons />} />
            <Route path="pacotes" element={<Packages />} />
            <Route path="marketplace" element={<AdminMarket />} />
            <Route path="auditoria" element={<Audit />} />
            <Route path="vibes" element={<AdminVibes />} />
            <Route path="vibes/nova" element={<NewAuction />} />
            <Route path="vibes/:id/editar" element={<EditAuction />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
)
