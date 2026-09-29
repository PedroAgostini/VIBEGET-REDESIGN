import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { motion } from 'framer-motion'
import { ArrowRight, Check, CircleNotch, CreditCard, PixLogo, Storefront, Wallet as WalletIcon, WarningCircle, X } from '@phosphor-icons/react'
import { api, brl, coins, fieldErrors, newIdempotencyKey } from '../../lib/api.js'
import { useApi } from '../../lib/useApi.js'
import { useAuth } from '../../lib/auth.jsx'
import { Field, FormAlert, Submit } from '../../components/form.jsx'
import { CopyButton } from './Home.jsx'
import { Coin, LoadError, PageHead, Pager, Skeleton, dateFmt } from './ui.jsx'

const ease = [0.16, 1, 0.3, 1]
const TABS = [['comprar', 'Comprar'], ['vender', 'Vender'], ['historico', 'Histórico']]
const METHODS = [['PIX', 'Pix', PixLogo], ['CARD', 'Cartão', CreditCard], ['BALANCE', 'Saldo', WalletIcon]]
const ORDER_STATUS = { PENDING_PAYMENT: ['Aguardando pagamento', 'wait'], PAID: ['Pago', 'ok'], FAILED: ['Não concluído', 'off'], REFUNDED: ['Estornado', 'off'] }
const LISTING_STATUS = { ACTIVE: ['Ativo', 'ok'], SOLD_OUT: ['Esgotado', 'wait'], CANCELLED: ['Cancelado', 'off'] }

const intOnly = (v) => v.replace(/\D/g, '').slice(0, 7)
/** "1,25" → 125 centavos (preço por GetCoin). */
const parseBrl = (v) => {
  const d = String(v).replace(/\D/g, '')
  return d ? parseInt(d, 10) : 0
}
const maskBrl = (v) => {
  const c = parseBrl(v)
  return c ? (c / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 }) : ''
}

/* ---------------- Comprar ---------------- */

function OrderWatch({ order: initial, onDone }) {
  const [order, setOrder] = useState(initial)
  const [simulating, setSimulating] = useState(false)
  const payment = order.payment ?? {}
  useEffect(() => {
    if (order.status !== 'PENDING_PAYMENT') {
      onDone(order)
      return
    }
    const id = setInterval(async () => {
      try { setOrder((await api(`/me/market/orders/${order.id}`)).data) } catch { /* tenta de novo */ }
    }, 3000)
    return () => clearInterval(id)
  }, [order.status]) // eslint-disable-line react-hooks/exhaustive-deps

  async function simulate() {
    setSimulating(true)
    try {
      await api(`/payments/${payment.id}/simulate`, { method: 'POST', body: { status: 'PAID' } })
      setOrder((await api(`/me/market/orders/${order.id}`)).data)
    } finally {
      setSimulating(false)
    }
  }
  if (order.status !== 'PENDING_PAYMENT') return null
  return (
    <div className="db-pix" aria-live="polite">
      <p className="db-pix-wait"><CircleNotch size={18} className="af-spin" aria-hidden="true" />Aguardando o pagamento de <b className="mono">{brl(order.totalPriceCents)}</b></p>
      {payment.pixCopyPaste ? (
        <>
          <p className="dh-text">Pague o Pix no app do seu banco. Os GetCoins entram na sua carteira assim que o pagamento for confirmado.</p>
          <code className="db-pix-code mono">{payment.pixCopyPaste}</code>
          <CopyButton value={payment.pixCopyPaste} label="Copiar código Pix" />
        </>
      ) : <p className="dh-text">Conclua o pagamento no cartão. Esta tela atualiza sozinha.</p>}
      {import.meta.env.DEV && payment.id && (
        <button type="button" className="btn btn-glass btn-sm" onClick={simulate} disabled={simulating}>Simular pagamento (só em desenvolvimento)</button>
      )}
    </div>
  )
}

function BuyBox({ listing, cashBalance, onClose, onBought }) {
  const [qty, setQty] = useState(String(Math.min(listing.remainingCents / 100, 10)))
  const [method, setMethod] = useState('PIX')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [order, setOrder] = useState(null)
  const key = useRef(newIdempotencyKey())
  const qtyCents = (parseInt(qty, 10) || 0) * 100
  const total = (qtyCents / 100) * listing.unitPriceCents
  const over = qtyCents > listing.remainingCents
  const cashShort = method === 'BALANCE' && total > cashBalance

  useEffect(() => { key.current = newIdempotencyKey() }, [qty, method])

  async function submit(e) {
    e.preventDefault()
    if (!qtyCents || over || cashShort) return
    setError(null)
    setBusy(true)
    try {
      const res = await api(`/market/listings/${listing.id}/orders`, {
        method: 'POST', body: { getcoinsCents: qtyCents, method }, headers: { 'Idempotency-Key': key.current },
      })
      key.current = newIdempotencyKey()
      if (res.data.status === 'PAID') onBought(res.data)
      else setOrder(res.data)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  function done(o) {
    if (o.status === 'PAID') onBought(o)
    else {
      setOrder(null)
      setError('O pagamento não foi concluído. Nenhum valor foi cobrado.')
    }
  }

  return (
    <motion.form
      className="mk-buy" onSubmit={submit} noValidate aria-label="Comprar deste anúncio"
      initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} transition={{ duration: 0.3, ease }}
    >
      <div className="mk-buy-row">
        <div className="af-field">
          <div className="af-label-row"><label htmlFor={`mk-q-${listing.id}`}>Quantos GetCoins?</label></div>
          <div className="db-custom-input">
            <Coin size="sm" />
            <input id={`mk-q-${listing.id}`} className="mono" inputMode="numeric" value={qty} onChange={(e) => setQty(intOnly(e.target.value))} disabled={Boolean(order)} />
          </div>
          {over && <p className="af-error"><WarningCircle size={16} weight="fill" aria-hidden="true" />Este anúncio tem {coins(listing.remainingCents)} disponíveis.</p>}
        </div>
        <p className="mk-buy-total">Total <b className="mono">{brl(total)}</b></p>
      </div>
      <div className="vd-methods">
        {METHODS.map(([id, label, Icon]) => (
          <label key={id} className={`db-method ${method === id ? 'is-selected' : ''}`}>
            <input type="radio" name={`mk-m-${listing.id}`} value={id} checked={method === id} onChange={() => setMethod(id)} disabled={Boolean(order)} />
            <Icon size={18} aria-hidden="true" /><span>{label}</span>
          </label>
        ))}
      </div>
      {cashShort && <FormAlert>Seu saldo em carteira é {brl(cashBalance)}. Escolha Pix ou cartão.</FormAlert>}
      <FormAlert>{error}</FormAlert>
      {order ? (
        <OrderWatch order={order} onDone={done} />
      ) : (
        <div className="mk-buy-actions">
          <button type="button" className="btn btn-glass" onClick={onClose}>Cancelar</button>
          <Submit busy={busy} disabled={!qtyCents || over || cashShort} busyLabel="Gerando pagamento…">Comprar {qtyCents ? coins(qtyCents) : ''} GetCoins</Submit>
        </div>
      )}
    </motion.form>
  )
}

function BuyTab({ myListingIds }) {
  const { user } = useAuth()
  const [page, setPage] = useState(1)
  const [sort, setSort] = useState('price')
  const list = useApi(`/market/listings?sort=${sort}&page=${page}&pageSize=15`)
  const cash = useApi('/me/cash?pageSize=1')
  const [open, setOpen] = useState(null)
  const [bought, setBought] = useState(null)
  const rows = list.data?.data ?? []
  const config = list.data?.config
  const unverified = Boolean(user && !user.emailVerified)

  if (config && !config.enabled) {
    return <section className="dc-section glass"><p className="dh-text">O marketplace está pausado no momento.</p></section>
  }
  return (
    <section className="dg-history glass" aria-labelledby="mk-list-title">
      <div className="dh-block-head">
        <h2 id="mk-list-title" className="dh-section-title">Anúncios de GetCoins</h2>
        <label className="vp-sort mk-sort">
          <span className="sr-only">Ordenar</span>
          <select value={sort} onChange={(e) => { setSort(e.target.value); setPage(1) }}>
            <option value="price">Menor preço</option>
            <option value="recent">Mais recentes</option>
          </select>
        </label>
      </div>
      {bought && (
        <div className="af-alert af-alert-ok" role="status">
          <Check size={20} weight="bold" aria-hidden="true" />
          <div>Pronto! <b className="mono">{coins(bought.getcoinsCents)}</b> GetCoins entraram na sua carteira. <Link to="/dashboard/carteira" className="af-inline-link">Ver extrato</Link></div>
        </div>
      )}
      {unverified && <FormAlert>Confirme seu e-mail para comprar e vender no marketplace.</FormAlert>}
      {list.error ? <LoadError message={list.error} onRetry={list.reload} />
        : list.loading && !list.data ? <Skeleton lines={4} />
          : rows.length === 0 ? (
            <div className="dw-empty">
              <Storefront size={22} aria-hidden="true" />
              <div><p className="dw-empty-title">Nenhum anúncio agora</p><p className="dw-empty-copy">Quando alguém anunciar GetCoins, eles aparecem aqui. Você também pode vender os seus na aba Vender.</p></div>
            </div>
          ) : (
            <ul className="mk-list">
              {rows.map((l) => {
                const mine = myListingIds.has(l.id)
                const isOpen = open === l.id
                return (
                  <li key={l.id} className={`mk-item ${isOpen ? 'is-open' : ''}`}>
                    <div className="mk-row">
                      <span className="mk-seller">{mine ? 'Seu anúncio' : l.seller}</span>
                      <span className="mk-price"><span className="mono">{brl(l.unitPriceCents)}</span><span className="muted small"> por GetCoin</span></span>
                      <span className="mk-avail"><Coin size="sm" /><span className="mono">{coins(l.remainingCents)}</span><span className="muted small"> disponíveis</span></span>
                      {mine ? <span className="dg-pill dg-pill-off">Seu</span> : (
                        <button type="button" className={`btn btn-sm ${isOpen ? 'btn-glass' : 'btn-coin'}`} onClick={() => { setOpen(isOpen ? null : l.id); setBought(null) }} disabled={unverified}>
                          {isOpen ? <><X size={16} aria-hidden="true" />Fechar</> : <>Comprar<ArrowRight size={16} weight="bold" /></>}
                        </button>
                      )}
                    </div>
                    {isOpen && (
                      <BuyBox
                        listing={l}
                        cashBalance={cash.data?.data?.balanceCents ?? 0}
                        onClose={() => setOpen(null)}
                        onBought={(o) => { setOpen(null); setBought(o); list.reload(); cash.reload() }}
                      />
                    )}
                  </li>
                )
              })}
            </ul>
          )}
      <Pager meta={list.data?.meta} onPage={setPage} />
    </section>
  )
}

/* ---------------- Vender ---------------- */

function SellTab({ mine, onChange }) {
  const { user } = useAuth()
  const market = useApi('/market/listings?pageSize=1')
  const wallet = useApi('/me/wallet?pageSize=1')
  const [qty, setQty] = useState('')
  const [price, setPrice] = useState('')
  const [errors, setErrors] = useState({})
  const [alert, setAlert] = useState(null)
  const [busy, setBusy] = useState(false)
  const [cancelling, setCancelling] = useState(null)
  const config = market.data?.config
  const balance = wallet.data?.balanceCents ?? 0
  const qtyCents = (parseInt(qty, 10) || 0) * 100
  const unit = parseBrl(price)
  const gross = (qtyCents / 100) * unit
  const fee = config ? Math.floor((gross * config.feePercent) / 100) : 0

  async function submit(e) {
    e.preventDefault()
    setAlert(null)
    const found = {}
    if (!qtyCents) found.getcoinsCents = 'Informe quantos GetCoins quer vender.'
    else if (qtyCents > balance) found.getcoinsCents = `Você tem ${coins(balance)} GetCoins.`
    else if (config && qtyCents < config.minListingCents) found.getcoinsCents = `O mínimo por anúncio é ${coins(config.minListingCents)} GetCoins.`
    if (!unit) found.unitPriceCents = 'Informe o preço por GetCoin.'
    else if (config && (unit < config.minUnitPriceCents || unit > config.maxUnitPriceCents)) found.unitPriceCents = `O preço precisa ficar entre ${brl(config.minUnitPriceCents)} e ${brl(config.maxUnitPriceCents)}.`
    setErrors(found)
    if (Object.keys(found).length) return
    setBusy(true)
    try {
      await api('/me/market/listings', { method: 'POST', body: { getcoinsCents: qtyCents, unitPriceCents: unit } })
      setQty('')
      setPrice('')
      setAlert({ tone: 'ok', text: 'Anúncio publicado. Os GetCoins ficam reservados até serem vendidos ou até você cancelar.' })
      wallet.reload()
      onChange()
    } catch (err) {
      const byField = fieldErrors(err)
      if (Object.keys(byField).length) setErrors(byField)
      else setAlert({ tone: 'error', text: err.message })
    } finally {
      setBusy(false)
    }
  }

  async function cancel(id) {
    setCancelling(id)
    try {
      await api(`/me/market/listings/${id}/cancel`, { method: 'POST' })
      wallet.reload()
      onChange()
    } catch (err) {
      setAlert({ tone: 'error', text: err.message })
    } finally {
      setCancelling(null)
    }
  }

  const rows = mine.data?.data ?? []
  return (
    <>
      <section className="dc-section glass" aria-labelledby="mk-sell-title">
        <h2 id="mk-sell-title" className="dh-section-title">Vender GetCoins</h2>
        <p className="dh-text">
          Você tem <b className="mono">{coins(balance)}</b> GetCoins. O valor das vendas entra no seu Saldo em carteira
          {config ? <>, menos a taxa de <b className="mono">{config.feePercent}%</b> da plataforma</> : null}.
        </p>
        {user && !user.emailVerified ? <FormAlert>Confirme seu e-mail para vender no marketplace.</FormAlert> : (
          <form className="af-form dc-form" onSubmit={submit} noValidate aria-label="Criar anúncio">
            <FormAlert tone={alert?.tone}>{alert?.text}</FormAlert>
            <div className="dc-grid">
              <Field label="Quantidade de GetCoins" inputMode="numeric" value={qty} onChange={(e) => setQty(intOnly(e.target.value))} error={errors.getcoinsCents} hint={config ? `Mínimo ${coins(config.minListingCents)}` : undefined} />
              <Field label="Preço por GetCoin (R$)" inputMode="numeric" placeholder="0,00" value={price} onChange={(e) => setPrice(maskBrl(e.target.value))} error={errors.unitPriceCents} hint={config ? `Entre ${brl(config.minUnitPriceCents)} e ${brl(config.maxUnitPriceCents)}` : undefined} />
            </div>
            <dl className="vd-ledger mk-ledger">
              <div><dt>Se vender tudo</dt><dd className="mono">{brl(gross)}</dd></div>
              <div><dt>Taxa da plataforma{config ? ` (${config.feePercent}%)` : ''}</dt><dd className="mono">− {brl(fee)}</dd></div>
              <div className="vd-ledger-total"><dt>Você recebe</dt><dd className="mono">{brl(gross - fee)}</dd></div>
            </dl>
            <div className="dc-actions"><Submit busy={busy} busyLabel="Publicando…">Publicar anúncio</Submit></div>
          </form>
        )}
      </section>

      <section className="dg-history glass" aria-labelledby="mk-mine-title">
        <h2 id="mk-mine-title" className="dh-section-title">Meus anúncios</h2>
        {mine.error ? <LoadError message={mine.error} onRetry={mine.reload} />
          : mine.loading && !mine.data ? <Skeleton lines={3} />
            : rows.length === 0 ? <p className="dash-empty">Você ainda não anunciou GetCoins.</p> : (
              <ul className="mk-list">
                {rows.map((l) => {
                  const [label, tone] = LISTING_STATUS[l.status] ?? [l.status, 'off']
                  return (
                    <li key={l.id} className="mk-item">
                      <div className="mk-row">
                        <span className="mk-price"><span className="mono">{brl(l.unitPriceCents)}</span><span className="muted small"> por GetCoin</span></span>
                        <span className="mk-avail muted small">
                          Vendidos <span className="mono ink">{coins(l.soldCents ?? 0)}</span> · Restam <span className="mono ink">{coins(l.remainingCents)}</span>
                          {l.reservedCents ? <> · Em pagamento <span className="mono ink">{coins(l.reservedCents)}</span></> : null}
                        </span>
                        <span className={`dg-pill dg-pill-${tone}`}>{label}</span>
                        {l.status === 'ACTIVE' ? (
                          <button type="button" className="btn btn-glass btn-sm" onClick={() => cancel(l.id)} disabled={cancelling === l.id}>
                            {cancelling === l.id ? 'Cancelando…' : 'Cancelar'}
                          </button>
                        ) : <span />}
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}
      </section>
    </>
  )
}

/* ---------------- Histórico ---------------- */

function OrdersTable({ rows, kind }) {
  return (
    <div className="dg-table-wrap">
      <table className="dg-table">
        <thead>
          <tr>
            <th scope="col">Data</th>
            <th scope="col" className="num">GetCoins</th>
            <th scope="col" className="num">Preço</th>
            <th scope="col" className="num">{kind === 'sale' ? 'Você recebeu' : 'Total'}</th>
            <th scope="col">Situação</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((o) => {
            const [label, tone] = ORDER_STATUS[o.status] ?? [o.status, 'off']
            return (
              <tr key={o.id}>
                <td className="mono dg-date">{dateFmt.format(new Date(o.createdAt))}</td>
                <td className="mono num">{coins(o.getcoinsCents)}</td>
                <td className="mono num">{brl(o.unitPriceCents)}</td>
                <td className="mono num dg-total">
                  {kind === 'sale' ? brl(o.sellerNetCents) : brl(o.totalPriceCents)}
                  {kind === 'sale' && o.feeCents ? <span className="dg-vibe-status">taxa {brl(o.feeCents)}</span> : null}
                </td>
                <td><span className={`dg-pill dg-pill-${tone}`}>{label}</span></td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function HistoryTab() {
  const orders = useApi('/me/market/orders?pageSize=20')
  const sales = useApi('/me/market/sales?pageSize=20')
  const block = (res, kind, empty) => (res.error ? <LoadError message={res.error} onRetry={res.reload} />
    : res.loading && !res.data ? <Skeleton lines={3} />
      : (res.data?.data ?? []).length === 0 ? <p className="dash-empty">{empty}</p>
        : <OrdersTable rows={res.data.data} kind={kind} />)
  return (
    <>
      <section className="dg-history glass" aria-labelledby="mk-orders-title">
        <h2 id="mk-orders-title" className="dh-section-title">Minhas compras</h2>
        {block(orders, 'order', 'Nenhuma compra no marketplace ainda.')}
      </section>
      <section className="dg-history glass" aria-labelledby="mk-sales-title">
        <h2 id="mk-sales-title" className="dh-section-title">Minhas vendas</h2>
        {block(sales, 'sale', 'Nenhuma venda ainda.')}
      </section>
    </>
  )
}

/* ---------------- Página ---------------- */

export default function Market() {
  const [params, setParams] = useSearchParams()
  const tab = TABS.some(([id]) => id === params.get('aba')) ? params.get('aba') : 'comprar'
  const mine = useApi('/me/market/listings')
  const myIds = new Set((mine.data?.data ?? []).map((l) => l.id))

  return (
    <div className="dp">
      <PageHead title="Marketplace">
        <div className="auth-tabs mk-tabs" role="tablist" aria-label="Marketplace">
          {TABS.map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id} className="auth-tab" onClick={() => setParams(id === 'comprar' ? {} : { aba: id }, { replace: true })}>
              {tab === id && <motion.span layoutId="mk-tab-pill" className="auth-tab-pill" transition={{ duration: 0.4, ease }} />}
              <span className="auth-tab-label">{label}</span>
            </button>
          ))}
        </div>
      </PageHead>
      <p className="dh-text mk-lede">Compre GetCoins de outros usuários ou venda os seus. O pagamento passa pela plataforma e o vendedor recebe no Saldo em carteira.</p>
      {tab === 'comprar' && <BuyTab myListingIds={myIds} />}
      {tab === 'vender' && <SellTab mine={mine} onChange={mine.reload} />}
      {tab === 'historico' && <HistoryTab />}
    </div>
  )
}
