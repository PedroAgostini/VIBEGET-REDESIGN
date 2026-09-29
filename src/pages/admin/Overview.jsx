import { Link, useOutletContext } from 'react-router-dom'
import { ArrowRight, ChartLineUp, Coins, Gavel, MapPin, Money, Package, Storefront, Users } from '@phosphor-icons/react'
import { brl, coins } from '../../lib/api.js'
import { LoadError, Skeleton } from '../dashboard/ui.jsx'

const VIBE_STATUS = [
  ['LIVE', 'Ao vivo', 'live'],
  ['SCHEDULED', 'Agendadas', 'coin'],
  ['ENDED', 'Encerradas', 'ink'],
  ['DRAFT', 'Rascunhos', 'muted'],
  ['CANCELLED', 'Canceladas', 'faint'],
]
const today = new Intl.DateTimeFormat('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' })

function Todo({ to, Icon, title, count, detail, idle }) {
  const active = count > 0
  return (
    <Link to={to} className={`ad-todo glass ${active ? 'is-active' : ''}`}>
      <span className="ad-todo-top">
        <span className="ad-todo-icon"><Icon size={20} aria-hidden="true" /></span>
        <ArrowRight size={18} className="ad-todo-arrow" aria-hidden="true" />
      </span>
      <span className="mono ad-todo-n">{count}</span>
      <span className="ad-todo-title">{title}</span>
      <span className="ad-todo-detail">{active ? detail : idle}</span>
    </Link>
  )
}

function Kpi({ Icon, label, value, note }) {
  return (
    <div className="ad-kpi glass">
      <dt><span className="ad-kpi-icon"><Icon size={16} aria-hidden="true" /></span>{label}</dt>
      <dd className="mono">{value}</dd>
      <p>{note}</p>
    </div>
  )
}

export default function Overview() {
  const { dashboard } = useOutletContext()
  const d = dashboard.data?.data
  if (dashboard.error) return <LoadError message={dashboard.error} onRetry={dashboard.reload} />
  if (!d) return <Skeleton lines={6} />
  const p = d.pending
  const waiting = [p.withdrawals.count, p.prizesToShip].filter((n) => n > 0).length
  const vibeTotal = VIBE_STATUS.reduce((a, [id]) => a + (d.vibes.byStatus[id] ?? 0), 0)
  const balance = d.getcoin.issuedCents - d.getcoin.spentCents
  const spentPct = d.getcoin.issuedCents ? Math.round((d.getcoin.spentCents / d.getcoin.issuedCents) * 100) : 0

  return (
    <div className="dp">
      <header className="ad-hero">
        <p className="ad-hero-date">{today.format(new Date())}</p>
        <h1 className="dp-title">Visão geral</h1>
        <p className="ad-hero-sub">
          {waiting === 0 ? 'Tudo em dia: nenhum saque ou envio esperando.' : `${waiting === 1 ? 'Uma fila espera' : 'Duas filas esperam'} a equipe hoje.`}
        </p>
      </header>

      <section className="ad-section" aria-labelledby="ad-todo-title">
        <h2 id="ad-todo-title" className="dh-section-title">Esperando a equipe</h2>
        <div className="ad-todos">
          <Todo
            to="/admin/saques" Icon={Money} title="Saques para pagar" count={p.withdrawals.count}
            detail={<><b className="mono">{brl(p.withdrawals.totalCents)}</b> reservados</>} idle="Nenhum saque esperando"
          />
          <Todo to="/admin/entregas" Icon={Package} title="Prêmios para enviar" count={p.prizesToShip} detail="Endereço já confirmado" idle="Nada para enviar agora" />
          <Todo
            to="/admin/entregas?status=AWAITING_ADDRESS" Icon={MapPin} title="Aguardando endereço" count={p.prizesAwaitingAddress}
            detail="O vencedor ainda não confirmou" idle="Todos confirmaram"
          />
        </div>
      </section>

      <section className="ad-section" aria-labelledby="ad-nums-title">
        <h2 id="ad-nums-title" className="dh-section-title">Plataforma</h2>
        <dl className="ad-kpis">
          <Kpi Icon={Users} label="Usuários" value={d.users.total} note={<><span className="mono">+{d.users.new7d}</span> em 7 dias · <span className="mono">{d.users.byLevel.VIBER ?? 0}</span> Vibers</>} />
          <Kpi Icon={ChartLineUp} label="Gets em 24 h" value={d.gets.last24h} note={<><span className="mono">{d.vibes.byStatus.LIVE ?? 0}</span> Vibes ao vivo</>} />
          <Kpi Icon={Coins} label="Receita confirmada" value={brl(d.revenue.confirmedCents)} note="Gets e compras de GetCoin" />
          <Kpi Icon={Storefront} label="Taxas do marketplace" value={brl(d.market.feeRevenueCents)} note={<><span className="mono">{d.market.paidOrders}</span> pedidos pagos</>} />
        </dl>
      </section>

      <div className="ad-split">
        <section className="ad-panel glass" aria-labelledby="ad-vibes-title">
          <div className="dh-block-head">
            <h2 id="ad-vibes-title" className="dh-section-title"><Gavel size={18} aria-hidden="true" />Vibes por situação</h2>
            <Link to="/admin/vibes?status=ALL" className="af-inline-link">Ver todas</Link>
          </div>
          <div className="ad-stack" role="img" aria-label={VIBE_STATUS.map(([id, label]) => `${label}: ${d.vibes.byStatus[id] ?? 0}`).join(', ')}>
            {VIBE_STATUS.map(([id, , tone]) => {
              const n = d.vibes.byStatus[id] ?? 0
              return n ? <span key={id} className={`ad-stack-${tone}`} style={{ flexGrow: n }} /> : null
            })}
          </div>
          <dl className="ad-legend">
            {VIBE_STATUS.map(([id, label, tone]) => (
              <Link key={id} to={`/admin/vibes?status=${id}`} className="ad-legend-row">
                <dt><span className={`ad-dot ad-stack-${tone}`} aria-hidden="true" />{label}</dt>
                <dd className="mono">{d.vibes.byStatus[id] ?? 0}</dd>
              </Link>
            ))}
          </dl>
          <p className="ad-panel-foot"><span className="mono">{vibeTotal}</span> Vibes no total</p>
        </section>

        <section className="ad-panel glass" aria-labelledby="ad-gc-title">
          <h2 id="ad-gc-title" className="dh-section-title"><Coins size={18} aria-hidden="true" />GetCoin em circulação</h2>
          <p className="ad-big mono">{coins(balance)}</p>
          <p className="ad-panel-note">nas carteiras e em custódia no marketplace</p>
          <div className="ad-bar" role="img" aria-label={`${spentPct}% do GetCoin emitido já foi gasto`}>
            <span style={{ width: `${spentPct}%` }} />
          </div>
          <dl className="ad-legend">
            <div className="ad-legend-row"><dt><span className="ad-dot ad-stack-coin" aria-hidden="true" />Emitido</dt><dd className="mono">{coins(d.getcoin.issuedCents)}</dd></div>
            <div className="ad-legend-row"><dt><span className="ad-dot ad-stack-ember" aria-hidden="true" />Gasto ou retirado</dt><dd className="mono">{coins(d.getcoin.spentCents)}</dd></div>
          </dl>
          <p className="ad-panel-foot">Emitido inclui bônus, cashback, compras e cupons.</p>
        </section>
      </div>
    </div>
  )
}
