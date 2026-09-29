import { useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { motion } from 'framer-motion'
import { ArrowRight, ClockCounterClockwise } from '@phosphor-icons/react'
import { api, brl, coins, fieldErrors, newIdempotencyKey } from '../../lib/api.js'
import { useApi } from '../../lib/useApi.js'
import { useAuth } from '../../lib/auth.jsx'
import { Field, FormAlert, Submit } from '../../components/form.jsx'
import { MOVEMENT } from './Home.jsx'
import { Coin, LoadError, PageHead, Pager, Skeleton, dateFmt } from './ui.jsx'

const ease = [0.16, 1, 0.3, 1]

const CASH_MOVEMENT = {
  GET_PAYMENT: 'Pagamento de Get',
  GETCOIN_PURCHASE: 'Compra de GetCoins',
  WITHDRAWAL: 'Saque',
  WITHDRAWAL_REVERSAL: 'Saque devolvido',
  REFUND: 'Estorno',
  ADJUSTMENT: 'Ajuste da equipe',
  MARKETPLACE_SALE: 'Venda no marketplace',
  MARKETPLACE_FEE: 'Taxa do marketplace',
}
const WITHDRAW_STATUS = { PENDING: ['Em análise', 'wait'], PAID: ['Pago', 'ok'], REJECTED: ['Recusado', 'off'] }
const PIX_TYPES = [['CPF', 'CPF'], ['EMAIL', 'E-mail'], ['PHONE', 'Celular'], ['RANDOM', 'Chave aleatória']]

/** "1.234,56" → 123456 centavos. */
const parseBrl = (v) => {
  const d = v.replace(/\D/g, '')
  return d ? parseInt(d, 10) : 0
}
const maskBrl = (v) => {
  const cents = parseBrl(v)
  return cents ? (cents / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 }) : ''
}

function Ledger({ rows, labels, money }) {
  return (
    <div className="dg-table-wrap">
      <table className="dg-table dw-ledger">
        <thead>
          <tr>
            <th scope="col">Movimentação</th>
            <th scope="col">Data</th>
            <th scope="col" className="num">Valor</th>
            <th scope="col" className="num">Saldo depois</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((m) => (
            <tr key={m.id}>
              <th scope="row">
                {labels[m.type] ?? m.type}
                {m.reason ? <span className="dg-vibe-status">{m.reason}</span> : null}
                <time className="mono dg-date dw-mobile-date" dateTime={m.createdAt}>{dateFmt.format(new Date(m.createdAt))}</time>
              </th>
              <td className="mono dg-date">{dateFmt.format(new Date(m.createdAt))}</td>
              <td className={`mono num ${m.amountCents >= 0 ? 'dw-in' : ''}`}>{m.amountCents >= 0 ? '+' : '−'}{money(Math.abs(m.amountCents))}</td>
              <td className="mono num">{m.balanceAfterCents != null ? money(m.balanceAfterCents) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function LedgerEmpty({ cash = false }) {
  return (
    <div className="dw-empty">
      <ClockCounterClockwise size={22} aria-hidden="true" />
      <div>
        <p className="dw-empty-title">Seu histórico começa aqui</p>
        <p className="dw-empty-copy">
          {cash
            ? 'Pagamentos, saques e estornos aparecerão assim que houver uma movimentação.'
            : 'Compras, bônus e uso de GetCoin aparecerão assim que houver uma movimentação.'}
        </p>
      </div>
    </div>
  )
}

function GetcoinTab() {
  const [page, setPage] = useState(1)
  const wallet = useApi(`/me/wallet?page=${page}&pageSize=20`)
  // O extrato já traz o saldo; não precisa carregar o dashboard inteiro.
  const balance = wallet.data?.balanceCents
  const rows = wallet.data?.data ?? []
  return (
    <>
      <section className="dw-balance glass">
        <div>
          <h2 className="dash-label">GetCoins</h2>
          <p className="dh-amount dh-amount-coin"><Coin /><span className="mono">{balance != null ? coins(balance) : '—'}</span></p>
        </div>
        <Link to="/dashboard/comprar" className="btn btn-coin">Comprar GetCoins<ArrowRight size={18} weight="bold" aria-hidden="true" /></Link>
      </section>
      <section className="dg-history glass" aria-labelledby="dw-gc-title">
        <h2 id="dw-gc-title" className="dh-section-title">Extrato de GetCoin</h2>
        {wallet.error ? <LoadError message={wallet.error} onRetry={wallet.reload} />
          : wallet.loading && !wallet.data ? <Skeleton lines={5} />
            : rows.length === 0 ? <LedgerEmpty />
              : <Ledger rows={rows} labels={MOVEMENT} money={coins} />}
        <Pager meta={wallet.data?.meta} onPage={setPage} />
      </section>
    </>
  )
}

function WithdrawForm({ balanceCents, onDone }) {
  const { user } = useAuth()
  const [amount, setAmount] = useState('')
  const [pixKeyType, setPixKeyType] = useState('CPF')
  const [pixKey, setPixKey] = useState('')
  const [errors, setErrors] = useState({})
  const [alert, setAlert] = useState(null)
  const [busy, setBusy] = useState(false)
  const key = useRef(newIdempotencyKey())

  const blocked = user && (!user.emailVerified || !user.hasCpf)

  async function submit(e) {
    e.preventDefault()
    setAlert(null)
    const amountCents = parseBrl(amount)
    const found = {}
    if (!amountCents) found.amountCents = 'Informe o valor do saque.'
    else if (balanceCents != null && amountCents > balanceCents) found.amountCents = 'O valor é maior que o seu saldo.'
    if (!pixKey.trim()) found.pixKey = 'Informe a chave Pix.'
    setErrors(found)
    if (Object.keys(found).length) return
    setBusy(true)
    try {
      await api('/me/withdrawals', {
        method: 'POST',
        body: { amountCents, pixKeyType, pixKey: pixKey.trim() },
        headers: { 'Idempotency-Key': key.current },
      })
      key.current = newIdempotencyKey()
      setAmount('')
      setPixKey('')
      setAlert({ tone: 'ok', text: 'Pedido de saque enviado. O valor fica reservado enquanto a equipe analisa.' })
      onDone()
    } catch (err) {
      const byField = fieldErrors(err)
      if (Object.keys(byField).length) setErrors(byField)
      else setAlert({ tone: 'error', text: err.message })
    } finally {
      setBusy(false)
    }
  }

  if (blocked) {
    return (
      <p className="dh-text">
        Para sacar, confirme seu e-mail e informe seu CPF em <Link to="/dashboard/conta" className="af-inline-link">Minha conta</Link>.
      </p>
    )
  }
  return (
    <form className="af-form dc-form" onSubmit={submit} noValidate aria-label="Pedir saque">
      <FormAlert tone={alert?.tone}>{alert?.text}</FormAlert>
      <div className="dc-grid dw-grid">
        <Field label="Valor (R$)" inputMode="numeric" placeholder="0,00" value={amount} onChange={(e) => setAmount(maskBrl(e.target.value))} error={errors.amountCents} />
        <div className="af-field">
          <div className="af-label-row"><label htmlFor="dw-pixtype">Tipo de chave Pix</label></div>
          <select id="dw-pixtype" className="af-input af-select" value={pixKeyType} onChange={(e) => setPixKeyType(e.target.value)}>
            {PIX_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </div>
        <Field label="Chave Pix" autoComplete="off" value={pixKey} onChange={(e) => setPixKey(e.target.value)} error={errors.pixKey} hint={pixKeyType === 'CPF' ? 'Use o CPF cadastrado na sua conta.' : 'A chave precisa estar registrada no seu CPF.'} />
      </div>
      <div className="dc-actions"><Submit busy={busy} busyLabel="Enviando…">Pedir saque</Submit></div>
    </form>
  )
}

function CashTab() {
  const [page, setPage] = useState(1)
  const cash = useApi(`/me/cash?page=${page}&pageSize=20`)
  const withdrawals = useApi('/me/withdrawals?pageSize=10')
  const balance = cash.data?.data?.balanceCents
  const ledger = cash.data?.ledger ?? cash.data?.data?.ledger
  const rows = ledger?.data ?? []
  const wRows = withdrawals.data?.data ?? []
  const refresh = () => { cash.reload(); withdrawals.reload() }

  return (
    <>
      <section className="dw-balance glass">
        <div>
          <h2 className="dash-label">Saldo em carteira</h2>
          <p className="dh-amount mono">{balance != null ? brl(balance) : '—'}</p>
          <p className="dh-text">Pode pagar Gets e compras de GetCoins, ou ser sacado via Pix.</p>
        </div>
      </section>

      <section className="dc-section glass" aria-labelledby="dw-withdraw-title">
        <h2 id="dw-withdraw-title" className="dh-section-title">Sacar via Pix</h2>
        <WithdrawForm balanceCents={balance} onDone={refresh} />
        {wRows.length > 0 && (
          <ul className="dw-withdrawals">
            {wRows.map((w) => {
              const [label, tone] = WITHDRAW_STATUS[w.status] ?? [w.status, 'off']
              return (
                <li key={w.id}>
                  <span className="mono">{brl(w.amountCents)}</span>
                  <span className="dw-w-key">{w.pixKeyMasked}</span>
                  <time className="mono dg-date" dateTime={w.createdAt}>{dateFmt.format(new Date(w.createdAt))}</time>
                  <span className={`dg-pill dg-pill-${tone}`}>{label}</span>
                  {w.rejectReason && <span className="dw-w-reason">{w.rejectReason}</span>}
                </li>
              )
            })}
          </ul>
        )}
      </section>

      <section className="dg-history glass" aria-labelledby="dw-cash-title">
        <h2 id="dw-cash-title" className="dh-section-title">Extrato do saldo em carteira</h2>
        {cash.error ? <LoadError message={cash.error} onRetry={cash.reload} />
          : cash.loading && !cash.data ? <Skeleton lines={4} />
            : rows.length === 0 ? <LedgerEmpty cash />
              : <Ledger rows={rows} labels={CASH_MOVEMENT} money={brl} />}
        <Pager meta={ledger?.meta} onPage={setPage} />
      </section>
    </>
  )
}

const TABS = [['getcoin', 'GetCoins'], ['saldo', 'Saldo em carteira']]

export default function Wallet() {
  const [params, setParams] = useSearchParams()
  const tabRefs = useRef(new Map())
  const tab = params.get('aba') === 'saldo' ? 'saldo' : 'getcoin'

  const selectTab = (id) => setParams(id === 'saldo' ? { aba: 'saldo' } : {}, { replace: true })
  const onTabKeyDown = (event, index) => {
    let next = null
    if (event.key === 'ArrowRight') next = (index + 1) % TABS.length
    if (event.key === 'ArrowLeft') next = (index - 1 + TABS.length) % TABS.length
    if (event.key === 'Home') next = 0
    if (event.key === 'End') next = TABS.length - 1
    if (next == null) return
    event.preventDefault()
    const id = TABS[next][0]
    selectTab(id)
    tabRefs.current.get(id)?.focus()
  }

  return (
    <div className="dp">
      <PageHead title="Carteira">
        <div className="auth-tabs dw-tabs" role="tablist" aria-label="Carteiras">
          {TABS.map(([id, label], index) => (
            <button
              key={id} id={`dw-tab-${id}`} type="button" role="tab" aria-selected={tab === id}
              aria-controls={`dw-panel-${id}`} tabIndex={tab === id ? 0 : -1} className="auth-tab"
              ref={(node) => node ? tabRefs.current.set(id, node) : tabRefs.current.delete(id)}
              onClick={() => selectTab(id)} onKeyDown={(event) => onTabKeyDown(event, index)}
            >
              {tab === id && <motion.span layoutId="dw-tab-pill" className="auth-tab-pill" transition={{ duration: 0.45, ease }} />}
              <span className="auth-tab-label">{label}</span>
            </button>
          ))}
        </div>
      </PageHead>
      <div
        id={`dw-panel-${tab}`} role="tabpanel" aria-labelledby={`dw-tab-${tab}`}
        className="dw-panel" tabIndex={0}
      >
        {tab === 'saldo' ? <CashTab /> : <GetcoinTab />}
      </div>
    </div>
  )
}
