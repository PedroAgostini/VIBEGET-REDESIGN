import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { ArrowRight, Receipt, Storefront, X } from '@phosphor-icons/react'
import { api, brl, coins } from '../../lib/api.js'
import { useApi } from '../../lib/useApi.js'
import { LoadError, PageHead, Pager, Skeleton, dateFmt } from '../dashboard/ui.jsx'
import { ConfirmAction, FilterChips, ReadOnlyNote, useIsAdmin } from './ui.jsx'
import { initials } from './Users.jsx'

const LISTING_FILTERS = [['ACTIVE', 'À venda'], ['SOLD_OUT', 'Esgotados'], ['CANCELLED', 'Cancelados'], ['ALL', 'Todos']]
const ORDER_FILTERS = [['ALL', 'Todos'], ['PAID', 'Pagos'], ['PENDING_PAYMENT', 'Aguardando pagamento'], ['FAILED', 'Não pagos'], ['REFUNDED', 'Estornados']]
const LISTING_STATUS = { ACTIVE: ['À venda', 'ok'], SOLD_OUT: ['Esgotado', 'off'], CANCELLED: ['Cancelado', 'off'] }
const ORDER_STATUS = { PENDING_PAYMENT: ['Aguardando pagamento', 'wait'], PAID: ['Pago', 'ok'], FAILED: ['Não pago', 'off'], REFUNDED: ['Estornado', 'ember'] }
const METHOD = { PIX: 'Pix', CARD: 'Cartão', BALANCE: 'Saldo' }
const pick = (options, value, fallback) => (options.some(([id]) => id === value) ? value : fallback)

function Person({ id, name, email, label }) {
  return (
    <Link to={`/admin/usuarios/${id}`} className="mm-person">
      <span className="mk-avatar mm-avatar" aria-hidden="true">{initials(name)}</span>
      <span className="ad-user-main">
        {label && <span className="mm-person-label">{label}</span>}
        <span className="ad-who-name">{name}</span>
        <span className="ad-who-meta">{email}</span>
      </span>
    </Link>
  )
}

function ListingCard({ l, isAdmin, onChanged, onOrders }) {
  const [label, tone] = LISTING_STATUS[l.status] ?? [l.status, 'off']
  const pct = (n) => (l.totalCents ? `${(n / l.totalCents) * 100}%` : '0%')
  // Disponível = o que sobrou e não está preso em pedido aberto.
  const free = Math.max(0, l.remainingCents - l.reservedCents)
  const cancel = async () => {
    await api(`/admin/market/listings/${l.id}/cancel`, { method: 'POST' })
    onChanged()
  }

  return (
    <li className={`ad-item glass mm-card ${l.status === 'ACTIVE' ? '' : 'is-paused'}`}>
      <div className="cp-head">
        <Person id={l.sellerId} name={l.sellerName} email={l.sellerEmail} label="Vendedor" />
        <span className={`dg-pill dg-pill-${tone}`}>{label}</span>
      </div>
      <dl className="cp-figs">
        <div><dt>Preço por GetCoin</dt><dd className="mono cp-amount">{brl(l.unitPriceCents)}</dd></div>
        <div><dt>Anunciado</dt><dd><span className="mono">{coins(l.totalCents)}</span> GetCoins</dd></div>
        <div><dt>Vendido</dt><dd><span className="mono">{coins(l.soldCents)}</span> · <span className="mono">{brl((l.soldCents / 100) * l.unitPriceCents)}</span></dd></div>
        <div><dt>Publicado em</dt><dd className="mono">{dateFmt.format(new Date(l.createdAt))}</dd></div>
      </dl>
      <div className="mm-progress">
        <div className="ad-stack" aria-hidden="true">
          {l.soldCents > 0 && <span className="ad-stack-coin" style={{ width: pct(l.soldCents) }} />}
          {l.reservedCents > 0 && <span className="ad-stack-ember" style={{ width: pct(l.reservedCents) }} />}
          {free > 0 && <span className="ad-stack-faint" style={{ width: pct(free) }} />}
        </div>
        <p className="mm-legend">
          <span><i className="ad-dot ad-stack-coin" />Vendido <b className="mono">{coins(l.soldCents)}</b></span>
          {l.reservedCents > 0 && <span><i className="ad-dot ad-stack-ember" />Em pedidos abertos <b className="mono">{coins(l.reservedCents)}</b></span>}
          {l.status === 'ACTIVE' && <span><i className="ad-dot ad-stack-faint" />Disponível <b className="mono">{coins(free)}</b></span>}
        </p>
      </div>
      <div className="ad-item-actions">
        <button type="button" className="btn btn-sm btn-glass" onClick={() => onOrders(l.id)}><Receipt size={16} aria-hidden="true" />Ver pedidos</button>
        {isAdmin && l.status === 'ACTIVE' && (
          <ConfirmAction
            label="Cancelar anúncio" tone="danger" confirmLabel="Cancelar e devolver"
            warning={`Os ${coins(l.remainingCents)} GetCoins que sobraram voltam para ${l.sellerName}. Pedidos aguardando pagamento continuam; se não forem pagos, esses GetCoins também voltam para ele.`}
            onConfirm={cancel}
          />
        )}
      </div>
    </li>
  )
}

function Listings({ isAdmin, onOrders }) {
  const [params, setParams] = useSearchParams()
  const status = pick(LISTING_FILTERS, params.get('status'), 'ACTIVE')
  const [page, setPage] = useState(1)
  const query = status === 'ALL' ? '' : `&status=${status}`
  const list = useApi(`/admin/market/listings?page=${page}&pageSize=20${query}`)
  const rows = list.data?.data ?? []
  const setStatus = (s) => {
    const next = new URLSearchParams(params)
    if (s === 'ACTIVE') next.delete('status')
    else next.set('status', s)
    setParams(next, { replace: true })
    setPage(1)
  }

  return (
    <>
      <FilterChips label="Filtrar anúncios" options={LISTING_FILTERS} value={status} onChange={setStatus} />
      {list.error ? <LoadError message={list.error} onRetry={list.reload} />
        : list.loading && !list.data ? <Skeleton lines={5} />
          : rows.length === 0 ? (
            <div className="dg-onboarding glass">
              <Storefront size={32} weight="duotone" aria-hidden="true" />
              <div className="dg-onboarding-copy">
                <h2 className="dh-section-title">{status === 'ACTIVE' ? 'Nenhum anúncio à venda' : 'Nada por aqui'}</h2>
                <p className="dh-text">{status === 'ACTIVE' ? 'Quando alguém anunciar GetCoins no marketplace, o anúncio aparece aqui.' : 'Nenhum anúncio com essa situação.'}</p>
              </div>
            </div>
          ) : (
            <ul className="ad-list">{rows.map((l) => <ListingCard key={`${l.id}-${l.status}`} l={l} isAdmin={isAdmin} onChanged={list.reload} onOrders={onOrders} />)}</ul>
          )}
      <Pager meta={list.data?.meta} onPage={setPage} />
    </>
  )
}

function Orders() {
  const [params, setParams] = useSearchParams()
  const status = pick(ORDER_FILTERS, params.get('status'), 'ALL')
  const listingId = params.get('anuncio')
  const [page, setPage] = useState(1)
  const query = new URLSearchParams({ page: String(page), pageSize: '20' })
  if (status !== 'ALL') query.set('status', status)
  if (listingId) query.set('listingId', listingId)
  const list = useApi(`/admin/market/orders?${query}`)
  const rows = list.data?.data ?? []
  const setParam = (key, value, empty) => {
    const next = new URLSearchParams(params)
    if (!value || value === empty) next.delete(key)
    else next.set(key, value)
    setParams(next, { replace: true })
    setPage(1)
  }

  return (
    <>
      <FilterChips label="Filtrar pedidos" options={ORDER_FILTERS} value={status} onChange={(s) => setParam('status', s, 'ALL')} />
      {listingId && (
        <p className="mm-scope">
          Mostrando só os pedidos de um anúncio.
          <button type="button" className="mm-scope-clear" onClick={() => setParam('anuncio', null)}><X size={14} weight="bold" aria-hidden="true" />Ver todos</button>
        </p>
      )}
      {list.error ? <LoadError message={list.error} onRetry={list.reload} />
        : list.loading && !list.data ? <Skeleton lines={5} />
          : rows.length === 0 ? (
            <div className="dg-onboarding glass">
              <Receipt size={32} weight="duotone" aria-hidden="true" />
              <div className="dg-onboarding-copy">
                <h2 className="dh-section-title">Nenhum pedido</h2>
                <p className="dh-text">{status === 'ALL' && !listingId ? 'Ninguém comprou GetCoins no marketplace ainda.' : 'Nenhum pedido com esse filtro.'}</p>
              </div>
            </div>
          ) : (
            <ul className="ad-list">
              {rows.map((o) => {
                const [label, tone] = ORDER_STATUS[o.status] ?? [o.status, 'off']
                return (
                  <li key={o.id} className="ad-item glass mm-order">
                    <div className="mm-order-head">
                      <div className="mm-order-people">
                        <Person id={o.buyerId} name={o.buyerName} email={o.buyerEmail} label="Comprador" />
                        <ArrowRight size={18} className="mm-order-arrow" aria-label="comprou de" />
                        <Person id={o.sellerId} name={o.sellerName} email={o.sellerEmail} label="Vendedor" />
                      </div>
                      <span className={`dg-pill dg-pill-${tone}`}>{label}</span>
                    </div>
                    <dl className="cp-figs">
                      <div><dt>GetCoins</dt><dd className="mono cp-amount">{coins(o.getcoinsCents)}</dd></div>
                      <div><dt>Pago</dt><dd><span className="mono">{brl(o.totalPriceCents)}</span> · {METHOD[o.method] ?? o.method}</dd></div>
                      <div><dt>Taxa VibeGet</dt><dd><span className="mono">{coins(o.feeCents)}</span> GetCoins</dd></div>
                      <div><dt>Pedido em</dt><dd className="mono">{dateFmt.format(new Date(o.createdAt))}</dd></div>
                    </dl>
                  </li>
                )
              })}
            </ul>
          )}
      <Pager meta={list.data?.meta} onPage={setPage} />
    </>
  )
}

export default function AdminMarket() {
  const isAdmin = useIsAdmin()
  const [params, setParams] = useSearchParams()
  const tab = params.get('aba') === 'pedidos' ? 'pedidos' : 'anuncios'
  // Resumo do topo: só as contagens (pageSize=1) e a receita de taxas que a rota de pedidos já devolve.
  const active = useApi('/admin/market/listings?status=ACTIVE&pageSize=1')
  const paid = useApi('/admin/market/orders?status=PAID&pageSize=1')
  const pending = useApi('/admin/market/orders?status=PENDING_PAYMENT&pageSize=1')
  const go = (next) => setParams(next)

  return (
    <div className="dp">
      <PageHead title="Marketplace" />
      {!isAdmin && <ReadOnlyNote />}
      <dl className="ad-kpis">
        <div className="ad-kpi glass"><dt>Anúncios à venda</dt><dd className="mono">{active.data?.meta.total ?? '—'}</dd></div>
        <div className="ad-kpi glass"><dt>Pedidos pagos</dt><dd className="mono">{paid.data?.meta.total ?? '—'}</dd></div>
        <div className="ad-kpi glass"><dt>Aguardando pagamento</dt><dd className="mono">{pending.data?.meta.total ?? '—'}</dd></div>
        <div className="ad-kpi glass"><dt>Taxas recebidas</dt><dd className="mono">{paid.data ? coins(paid.data.summary.feeRevenueCents) : '—'}</dd><p>em GetCoins</p></div>
      </dl>
      <div className="ad-filter mm-tabs" role="tablist" aria-label="Marketplace">
        <button type="button" role="tab" aria-selected={tab === 'anuncios'} className={`ad-filter-btn ${tab === 'anuncios' ? 'is-on' : ''}`} onClick={() => go({})}>
          <Storefront size={16} aria-hidden="true" />Anúncios
        </button>
        <button type="button" role="tab" aria-selected={tab === 'pedidos'} className={`ad-filter-btn ${tab === 'pedidos' ? 'is-on' : ''}`} onClick={() => go({ aba: 'pedidos' })}>
          <Receipt size={16} aria-hidden="true" />Pedidos
        </button>
      </div>
      {tab === 'anuncios'
        ? <Listings isAdmin={isAdmin} onOrders={(listingId) => go({ aba: 'pedidos', anuncio: listingId })} />
        : <Orders />}
    </div>
  )
}
