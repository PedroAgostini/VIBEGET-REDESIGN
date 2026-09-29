import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { motion } from 'framer-motion'
import { ArrowRight, Check, CircleNotch, CreditCard, PixLogo, Wallet as WalletIcon, WarningCircle, X } from '@phosphor-icons/react'
import { api, brl, fieldErrors, newIdempotencyKey } from '../../lib/api.js'
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
const QUICK_QTY = [10, 50, 100]

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
/** No marketplace a quantidade é sempre GetCoin inteiro: "250", não "250,00". */
const whole = (cents) => (cents / 100).toLocaleString('pt-BR', { maximumFractionDigits: 2 })
const initials = (name = '') => name.replace(/[^\p{L}\s]/gu, '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?'

const rtf = new Intl.RelativeTimeFormat('pt-BR', { numeric: 'auto' })
function ago(iso) {
  let v = (new Date(iso).getTime() - Date.now()) / 1000
  if (Math.abs(v) < 60) return 'agora mesmo'
  for (const [size, unit] of [[60, 'second'], [60, 'minute'], [24, 'hour'], [30, 'day'], [12, 'month']]) {
    if (Math.abs(v) < size) return rtf.format(Math.round(v), unit)
    v /= size
  }
  return rtf.format(Math.round(v), 'year')
}

/** Diferença do anúncio para o preço da loja, em % inteiro (positivo = mais barato). */
const vsStore = (unit, store) => (store ? Math.round((1 - unit / store) * 100) : null)
function StoreDelta({ unit, store }) {
  const pct = vsStore(unit, store)
  if (pct === null) return null
  if (pct > 0) return <p className="mk-delta is-good">{pct}% abaixo da loja</p>
  if (pct < 0) return <p className="mk-delta">{-pct}% acima da loja</p>
  return <p className="mk-delta">Mesmo preço da loja</p>
}

function Meter({ value, total, label }) {
  const pct = total ? Math.max(0, Math.min(100, (value / total) * 100)) : 0
  return (
    <span className="mk-meter" role="img" aria-label={label}>
      <span style={{ width: `${pct}%` }} />
    </span>
  )
}

/* ---------------- Resumo ---------------- */

function Summary({ best, total, store, balance }) {
  const pct = best ? vsStore(best, store) : null
  return (
    <dl className="mk-summary glass">
      <div>
        <dt>Menor preço agora</dt>
        <dd className="mono">{best ? brl(best) : '—'}</dd>
        <p>{pct > 0 ? <span className="mk-good">{pct}% abaixo da loja</span> : 'por GetCoin'}</p>
      </div>
      <div>
        <dt>Preço na loja</dt>
        <dd className="mono">{store ? brl(store) : '—'}</dd>
        <p><Link to="/dashboard/comprar" className="af-inline-link">Comprar direto</Link></p>
      </div>
      <div>
        <dt>Anúncios na vitrine</dt>
        <dd className="mono">{total ?? '—'}</dd>
        <p>de usuários verificados</p>
      </div>
      <div>
        <dt>Seus GetCoins</dt>
        <dd className="mono mk-summary-coin"><Coin size="sm" />{whole(balance)}</dd>
        <p>disponíveis para vender</p>
      </div>
    </dl>
  )
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

function BuyBox({ listing, store, cashBalance, onClose, onBought }) {
  const max = listing.remainingCents / 100
  const [qty, setQty] = useState(String(Math.min(max, 10)))
  const [method, setMethod] = useState('PIX')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [order, setOrder] = useState(null)
  const key = useRef(newIdempotencyKey())
  const qtyCents = (parseInt(qty, 10) || 0) * 100
  const total = (qtyCents / 100) * listing.unitPriceCents
  const atStore = store ? (qtyCents / 100) * store : 0
  const over = qtyCents > listing.remainingCents
  const cashShort = method === 'BALANCE' && total > cashBalance
  const locked = Boolean(order)

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
      className="mk-buy" onSubmit={submit} noValidate aria-label={`Comprar GetCoins de ${listing.seller}`}
      initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} transition={{ duration: 0.3, ease }}
    >
      <div className="mk-buy-grid">
        <div className="af-field">
          <div className="af-label-row"><label htmlFor={`mk-q-${listing.id}`}>Quantos GetCoins?</label></div>
          <div className="db-custom-input">
            <Coin size="sm" />
            <input id={`mk-q-${listing.id}`} className="mono" inputMode="numeric" value={qty} onChange={(e) => setQty(intOnly(e.target.value))} disabled={locked} />
          </div>
          <div className="vd-quick" role="group" aria-label="Quantidades rápidas">
            {QUICK_QTY.filter((n) => n < max).map((n) => (
              <button key={n} type="button" className="vd-quick-btn mono" onClick={() => setQty(String(n))} disabled={locked}>{n}</button>
            ))}
            <button type="button" className="vd-quick-btn" onClick={() => setQty(String(max))} disabled={locked}>Tudo · <span className="mono">{whole(listing.remainingCents)}</span></button>
          </div>
          {over && <p className="af-error"><WarningCircle size={16} weight="fill" aria-hidden="true" />Este anúncio tem {whole(listing.remainingCents)} GetCoins disponíveis.</p>}
        </div>
        <dl className="vd-ledger mk-buy-ledger">
          <div><dt><span className="mono">{qtyCents ? whole(qtyCents) : 0}</span> × <span className="mono">{brl(listing.unitPriceCents)}</span></dt><dd className="mono">{brl(total)}</dd></div>
          {atStore > total && <div className="mk-save"><dt>Na loja sairia</dt><dd className="mono"><s>{brl(atStore)}</s></dd></div>}
          <div className="vd-ledger-total"><dt>Você paga</dt><dd className="mono">{brl(total)}</dd></div>
        </dl>
      </div>
      <div className="vd-methods">
        {METHODS.map(([id, label, Icon]) => (
          <label key={id} className={`db-method ${method === id ? 'is-selected' : ''}`}>
            <input type="radio" name={`mk-m-${listing.id}`} value={id} checked={method === id} onChange={() => setMethod(id)} disabled={locked} />
            <Icon size={18} aria-hidden="true" /><span>{label}</span>
            {id === 'BALANCE' && <span className="db-method-bal mono">{brl(cashBalance)}</span>}
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
          <Submit busy={busy} disabled={!qtyCents || over || cashShort} busyLabel="Gerando pagamento…">Comprar {qtyCents ? whole(qtyCents) : ''} GetCoins</Submit>
        </div>
      )}
    </motion.form>
  )
}

function ListingRow({ listing: l, mine, best, store, open, disabled, onToggle, children }) {
  const leftPct = l.totalCents ? Math.round((l.remainingCents / l.totalCents) * 100) : 0
  return (
    <li className={`mk-item ${open ? 'is-open' : ''} ${best ? 'is-best' : ''}`}>
      <div className="mk-row">
        <div className="mk-seller">
          <span className={`mk-avatar ${mine ? 'is-mine' : ''}`} aria-hidden="true">{mine ? 'EU' : initials(l.seller)}</span>
          <div className="mk-seller-copy">
            <p className="mk-seller-name">
              <span>{mine ? 'Seu anúncio' : l.seller}</span>
              {best && <span className="mk-best">Menor preço</span>}
            </p>
            <p className="mk-meta">Anunciado {ago(l.createdAt)}</p>
          </div>
        </div>
        <div className="mk-price">
          <p><span className="mono mk-price-num">{brl(l.unitPriceCents)}</span><span className="mk-unit"> por GetCoin</span></p>
          <StoreDelta unit={l.unitPriceCents} store={store} />
        </div>
        <div className="mk-avail">
          <p><Coin size="sm" /><span className="mono mk-avail-num">{whole(l.remainingCents)}</span><span className="mk-unit"> de {whole(l.totalCents)}</span></p>
          <Meter value={l.remainingCents} total={l.totalCents} label={`${leftPct}% do anúncio ainda disponível`} />
        </div>
        <div className="mk-action">
          {mine ? (
            <Link to="?aba=vender" replace className="btn btn-glass btn-sm">Gerenciar</Link>
          ) : (
            <button type="button" className={`btn btn-sm ${open ? 'btn-glass' : best ? 'btn-coin' : 'btn-glass'}`} onClick={onToggle} disabled={disabled} aria-expanded={open}>
              {open ? <><X size={16} aria-hidden="true" />Fechar</> : <>Comprar<ArrowRight size={16} weight="bold" aria-hidden="true" /></>}
            </button>
          )}
        </div>
      </div>
      {children}
    </li>
  )
}

function BuyTab({ myListingIds, store, bestId, onTraded }) {
  const { user } = useAuth()
  const [, setParams] = useSearchParams()
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
    <section className="mk-board glass" aria-labelledby="mk-list-title">
      <div className="mk-board-head">
        <div>
          <h2 id="mk-list-title" className="dh-section-title">Anúncios de GetCoins</h2>
          <p className="mk-board-sub">Compre a quantidade que quiser de cada anúncio, até o que ele tem disponível.</p>
        </div>
        <label className="vp-sort mk-sort">
          <span className="sr-only">Ordenar anúncios</span>
          <select value={sort} onChange={(e) => { setSort(e.target.value); setPage(1) }}>
            <option value="price">Menor preço</option>
            <option value="recent">Mais recentes</option>
          </select>
        </label>
      </div>
      {bought && (
        <div className="af-alert af-alert-ok" role="status">
          <Check size={20} weight="bold" aria-hidden="true" />
          <div>Pronto! <b className="mono">{whole(bought.getcoinsCents)}</b> GetCoins entraram na sua carteira. <Link to="/dashboard/carteira" className="af-inline-link">Ver extrato</Link></div>
        </div>
      )}
      {unverified && <FormAlert>Confirme seu e-mail para comprar e vender no marketplace.</FormAlert>}
      {list.error ? <LoadError message={list.error} onRetry={list.reload} />
        : list.loading && !list.data ? <Skeleton lines={4} />
          : rows.length === 0 ? (
            <div className="mk-empty">
              <Coin size="lg" />
              <div>
                <p className="mk-empty-title">Nenhum anúncio agora</p>
                <p className="mk-empty-copy">Quando alguém anunciar GetCoins, eles aparecem aqui. Enquanto isso, você pode anunciar os seus ou comprar direto na loja.</p>
              </div>
              <div className="mk-empty-actions">
                <Link to="/dashboard/comprar" className="btn btn-glass">Comprar na loja</Link>
                <button type="button" className="btn btn-coin" onClick={() => setParams({ aba: 'vender' }, { replace: true })}>Anunciar meus GetCoins<ArrowRight size={18} weight="bold" aria-hidden="true" /></button>
              </div>
            </div>
          ) : (
            <>
              <div className="mk-cols" aria-hidden="true"><span>Vendedor</span><span>Preço</span><span>Disponível</span><span /></div>
              <ul className="mk-list">
                {rows.map((l) => {
                  const isOpen = open === l.id
                  return (
                    <ListingRow
                      key={l.id} listing={l} mine={myListingIds.has(l.id)} best={l.id === bestId} store={store}
                      open={isOpen} disabled={unverified}
                      onToggle={() => { setOpen(isOpen ? null : l.id); setBought(null) }}
                    >
                      {isOpen && (
                        <BuyBox
                          listing={l}
                          store={store}
                          cashBalance={cash.data?.data?.balanceCents ?? 0}
                          onClose={() => setOpen(null)}
                          onBought={(o) => { setOpen(null); setBought(o); list.reload(); cash.reload(); onTraded() }}
                        />
                      )}
                    </ListingRow>
                  )
                })}
              </ul>
            </>
          )}
      <Pager meta={list.data?.meta} onPage={setPage} />
    </section>
  )
}

/* ---------------- Vender ---------------- */

function SellTab({ mine, config, balance, bestPrice, store, onChange }) {
  const { user } = useAuth()
  const [qty, setQty] = useState('')
  const [price, setPrice] = useState('')
  const [errors, setErrors] = useState({})
  const [alert, setAlert] = useState(null)
  const [busy, setBusy] = useState(false)
  const [cancelling, setCancelling] = useState(null)
  const qtyCents = (parseInt(qty, 10) || 0) * 100
  const unit = parseBrl(price)
  const gross = (qtyCents / 100) * unit
  const fee = config ? Math.floor((gross * config.feePercent) / 100) : 0
  const maxWhole = Math.floor(balance / 100)
  const priceHints = [bestPrice && ['Igualar o menor', bestPrice], store && ['Preço da loja', store]]
    .filter(Boolean)
    .filter(([, c]) => !config || (c >= config.minUnitPriceCents && c <= config.maxUnitPriceCents))

  async function submit(e) {
    e.preventDefault()
    setAlert(null)
    const found = {}
    if (!qtyCents) found.getcoinsCents = 'Informe quantos GetCoins quer vender.'
    else if (qtyCents > balance) found.getcoinsCents = `Você tem ${whole(balance)} GetCoins.`
    else if (config && qtyCents < config.minListingCents) found.getcoinsCents = `O mínimo por anúncio é ${whole(config.minListingCents)} GetCoins.`
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
      <div className="mk-sell">
        <section className="dc-section glass" aria-labelledby="mk-sell-title">
          <div className="dc-section-head">
            <h2 id="mk-sell-title" className="dh-section-title">Anunciar GetCoins</h2>
            <p className="dh-text">Você tem <b className="mono">{whole(balance)}</b> GetCoins. Eles ficam reservados enquanto o anúncio estiver ativo.</p>
          </div>
          {user && !user.emailVerified ? <FormAlert>Confirme seu e-mail para vender no marketplace.</FormAlert> : (
            <form className="af-form dc-form mk-sell-form" onSubmit={submit} noValidate aria-label="Criar anúncio">
              <FormAlert tone={alert?.tone}>{alert?.text}</FormAlert>
              <div className="mk-sell-field">
                <Field label="Quantidade de GetCoins" inputMode="numeric" placeholder="0" value={qty} onChange={(e) => setQty(intOnly(e.target.value))} error={errors.getcoinsCents} hint={config ? `Mínimo de ${whole(config.minListingCents)} GetCoins por anúncio` : undefined} />
                {maxWhole > 0 && (
                  <div className="vd-quick" role="group" aria-label="Quantidade rápida">
                    <button type="button" className="vd-quick-btn" onClick={() => setQty(String(maxWhole))}>Tudo · <span className="mono">{whole(maxWhole * 100)}</span></button>
                    {maxWhole >= 2 && <button type="button" className="vd-quick-btn" onClick={() => setQty(String(Math.floor(maxWhole / 2)))}>Metade · <span className="mono">{whole(Math.floor(maxWhole / 2) * 100)}</span></button>}
                  </div>
                )}
              </div>
              <div className="mk-sell-field">
                <Field label="Preço por GetCoin (R$)" inputMode="numeric" placeholder="0,00" value={price} onChange={(e) => setPrice(maskBrl(e.target.value))} error={errors.unitPriceCents} hint={config ? `Entre ${brl(config.minUnitPriceCents)} e ${brl(config.maxUnitPriceCents)}` : undefined} />
                {priceHints.length > 0 && (
                  <div className="vd-quick" role="group" aria-label="Preços de referência">
                    {priceHints.map(([label, c]) => (
                      <button key={label} type="button" className="vd-quick-btn" onClick={() => setPrice(maskBrl(String(c)))}>{label} · <span className="mono">{brl(c)}</span></button>
                    ))}
                  </div>
                )}
              </div>
              <div className="dc-actions"><Submit busy={busy} busyLabel="Publicando…">Publicar anúncio</Submit></div>
            </form>
          )}
        </section>

        <aside className="mk-receipt glass" aria-labelledby="mk-receipt-title">
          <h2 id="mk-receipt-title" className="dh-section-title">Se vender tudo</h2>
          <dl className="vd-ledger">
            <div><dt><span className="mono">{qtyCents ? whole(qtyCents) : 0}</span> × <span className="mono">{brl(unit)}</span></dt><dd className="mono">{brl(gross)}</dd></div>
            <div><dt>Taxa da plataforma{config ? ` (${config.feePercent}%)` : ''}</dt><dd className="mono">− {brl(fee)}</dd></div>
            <div className="vd-ledger-total"><dt>Você recebe</dt><dd className="mono">{brl(gross - fee)}</dd></div>
          </dl>
          <ol className="mk-steps">
            <li><span className="mono">1</span><p><b>Você anuncia.</b> Os GetCoins saem da carteira e ficam reservados.</p></li>
            <li><span className="mono">2</span><p><b>Alguém compra.</b> Pode levar só uma parte; o resto continua à venda.</p></li>
            <li><span className="mono">3</span><p><b>Você recebe</b> no Saldo em carteira, já sem a taxa, e pode sacar por Pix.</p></li>
          </ol>
        </aside>
      </div>

      <section className="mk-board glass" aria-labelledby="mk-mine-title">
        <div className="mk-board-head">
          <h2 id="mk-mine-title" className="dh-section-title">Meus anúncios</h2>
        </div>
        {mine.error ? <LoadError message={mine.error} onRetry={mine.reload} />
          : mine.loading && !mine.data ? <Skeleton lines={3} />
            : rows.length === 0 ? <p className="dash-empty">Você ainda não anunciou GetCoins.</p> : (
              <ul className="mk-list">
                {rows.map((l) => {
                  const [label, tone] = LISTING_STATUS[l.status] ?? [l.status, 'off']
                  const sold = l.soldCents ?? 0
                  return (
                    <li key={l.id} className="mk-item">
                      <div className="mk-row mk-row-mine">
                        <div className="mk-price">
                          <p><span className="mono mk-price-num">{brl(l.unitPriceCents)}</span><span className="mk-unit"> por GetCoin</span></p>
                          <p className="mk-meta">Anunciado {ago(l.createdAt)}</p>
                        </div>
                        <div className="mk-avail">
                          <p className="mk-mine-figs">
                            <span>Vendidos <b className="mono">{whole(sold)}</b></span>
                            <span>Restam <b className="mono">{whole(l.remainingCents)}</b></span>
                            {l.reservedCents ? <span>Em pagamento <b className="mono">{whole(l.reservedCents)}</b></span> : null}
                          </p>
                          <Meter value={sold} total={l.totalCents} label={`${whole(sold)} de ${whole(l.totalCents)} GetCoins vendidos`} />
                        </div>
                        <span className={`dg-pill dg-pill-${tone}`}>{label}</span>
                        <div className="mk-action">
                          {l.status === 'ACTIVE' && (
                            <button type="button" className="btn btn-glass btn-sm" onClick={() => cancel(l.id)} disabled={cancelling === l.id}>
                              {cancelling === l.id ? 'Cancelando…' : 'Cancelar'}
                            </button>
                          )}
                        </div>
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
                <td className="mono num">{whole(o.getcoinsCents)}</td>
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
      <section className="mk-board glass" aria-labelledby="mk-orders-title">
        <h2 id="mk-orders-title" className="dh-section-title">Minhas compras</h2>
        {block(orders, 'order', 'Nenhuma compra no marketplace ainda.')}
      </section>
      <section className="mk-board glass" aria-labelledby="mk-sales-title">
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
  const top = useApi('/market/listings?sort=price&pageSize=1')
  const wallet = useApi('/me/wallet?pageSize=1')
  const packages = useApi('/getcoin-packages')
  const myIds = new Set((mine.data?.data ?? []).map((l) => l.id))
  const best = top.data?.data?.[0]
  const config = top.data?.config
  const custom = packages.data?.custom
  const store = custom?.enabled ? custom.unitPriceCents : null
  const balance = wallet.data?.balanceCents ?? 0
  const refresh = () => { mine.reload(); top.reload(); wallet.reload() }

  return (
    <div className="dp mk">
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
      <Summary best={best?.unitPriceCents} total={top.data?.meta?.total} store={store} balance={balance} />
      {tab === 'comprar' && <BuyTab myListingIds={myIds} store={store} bestId={best?.id} onTraded={refresh} />}
      {tab === 'vender' && <SellTab mine={mine} config={config} balance={balance} bestPrice={best?.unitPriceCents} store={store} onChange={refresh} />}
      {tab === 'historico' && <HistoryTab />}
    </div>
  )
}
