import { Link, useOutletContext } from 'react-router-dom'
import { ArrowRight, MapPin, Money, Package } from '@phosphor-icons/react'
import { brl, coins } from '../../lib/api.js'
import { LoadError, PageHead, Skeleton } from '../dashboard/ui.jsx'

const VIBE_STATUS = [['LIVE', 'Ao vivo'], ['SCHEDULED', 'Agendadas'], ['DRAFT', 'Rascunhos'], ['ENDED', 'Encerradas'], ['CANCELLED', 'Canceladas']]

function Todo({ to, Icon, title, count, detail, idle }) {
  const active = count > 0
  return (
    <Link to={to} className={`ad-todo glass ${active ? 'is-active' : ''}`}>
      <Icon size={22} className="ad-todo-icon" aria-hidden="true" />
      <div className="ad-todo-copy">
        <p className="ad-todo-title">{title}</p>
        <p className="ad-todo-detail">{active ? detail : idle}</p>
      </div>
      <span className="mono ad-todo-n">{count}</span>
      <ArrowRight size={18} className="ad-todo-arrow" aria-hidden="true" />
    </Link>
  )
}

export default function Overview() {
  const { dashboard } = useOutletContext()
  const d = dashboard.data?.data
  if (dashboard.error) return <LoadError message={dashboard.error} onRetry={dashboard.reload} />
  if (!d) return <Skeleton lines={6} />
  const p = d.pending

  return (
    <div className="dp">
      <PageHead title="Visão geral" />

      <section className="ad-section" aria-labelledby="ad-todo-title">
        <h2 id="ad-todo-title" className="dh-section-title">Esperando a equipe</h2>
        <div className="ad-todos">
          <Todo
            to="/admin/saques" Icon={Money} title="Saques para pagar" count={p.withdrawals.count}
            detail={<>Total de <b className="mono">{brl(p.withdrawals.totalCents)}</b> reservado</>} idle="Nenhum saque esperando"
          />
          <Todo to="/admin/entregas" Icon={Package} title="Prêmios para enviar" count={p.prizesToShip} detail="Endereço confirmado pelo vencedor" idle="Nada para enviar agora" />
          <Todo
            to="/admin/entregas?status=AWAITING_ADDRESS" Icon={MapPin} title="Aguardando endereço" count={p.prizesAwaitingAddress}
            detail="O vencedor ainda não confirmou" idle="Todos os vencedores confirmaram"
          />
        </div>
      </section>

      <section className="ad-section" aria-labelledby="ad-nums-title">
        <h2 id="ad-nums-title" className="dh-section-title">Plataforma</h2>
        <dl className="ad-kpis">
          <div className="ad-kpi glass">
            <dt>Usuários</dt>
            <dd className="mono">{d.users.total}</dd>
            <p><span className="mono">+{d.users.new7d}</span> nos últimos 7 dias · <span className="mono">{d.users.byLevel.VIBER ?? 0}</span> Vibers</p>
          </div>
          <div className="ad-kpi glass">
            <dt>Vibes ao vivo</dt>
            <dd className="mono">{d.vibes.byStatus.LIVE ?? 0}</dd>
            <p><span className="mono">{d.gets.last24h}</span> Gets nas últimas 24 h</p>
          </div>
          <div className="ad-kpi glass">
            <dt>Receita confirmada</dt>
            <dd className="mono">{brl(d.revenue.confirmedCents)}</dd>
            <p>Gets e compras de GetCoin pagos</p>
          </div>
          <div className="ad-kpi glass">
            <dt>Taxas do marketplace</dt>
            <dd className="mono">{brl(d.market.feeRevenueCents)}</dd>
            <p><span className="mono">{d.market.paidOrders}</span> pedidos pagos</p>
          </div>
        </dl>
      </section>

      <div className="ad-split">
        <section className="dg-history glass" aria-labelledby="ad-vibes-title">
          <div className="dh-block-head">
            <h2 id="ad-vibes-title" className="dh-section-title">Vibes por situação</h2>
            <Link to="/admin/vibes" className="af-inline-link">Ver Vibes</Link>
          </div>
          <dl className="ad-rows">
            {VIBE_STATUS.map(([id, label]) => (
              <div key={id}><dt>{label}</dt><dd className="mono">{d.vibes.byStatus[id] ?? 0}</dd></div>
            ))}
          </dl>
        </section>
        <section className="dg-history glass" aria-labelledby="ad-gc-title">
          <h2 id="ad-gc-title" className="dh-section-title">GetCoin em circulação</h2>
          <dl className="ad-rows">
            <div><dt>Emitido (bônus, cashback, compras, cupons)</dt><dd className="mono">{coins(d.getcoin.issuedCents)}</dd></div>
            <div><dt>Gasto ou retirado</dt><dd className="mono">{coins(d.getcoin.spentCents)}</dd></div>
            <div className="ad-rows-total"><dt>Saldo nas carteiras e em custódia</dt><dd className="mono">{coins(d.getcoin.issuedCents - d.getcoin.spentCents)}</dd></div>
          </dl>
        </section>
      </div>
    </div>
  )
}
