import { Navigate, Route, Routes } from 'react-router-dom'
import AdminShell from './AdminShell.jsx'
import Overview from './Overview.jsx'
import Withdrawals from './Withdrawals.jsx'
import Deliveries from './Deliveries.jsx'
import AdminVibes from './AdminVibes.jsx'
import NewAuction from './NewAuction.jsx'
import Users from './Users.jsx'
import UserDetail from './UserDetail.jsx'
import Settings from './Settings.jsx'
import Coupons from './Coupons.jsx'
import Packages from './Packages.jsx'
import EditAuction from './EditAuction.jsx'
import AdminMarket from './AdminMarket.jsx'
import Audit from './Audit.jsx'

/**
 * Rotas do painel /admin num pacote separado (carregado com lazy em main.jsx).
 * Quem não é da equipe nunca baixa este código: o RequireStaff barra antes do import.
 */
export default function AdminRoutes() {
  return (
    <Routes>
      <Route element={<AdminShell />}>
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
      <Route path="*" element={<Navigate to="/admin" replace />} />
    </Routes>
  )
}
