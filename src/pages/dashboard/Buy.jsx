import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowClockwise, Check, CircleNotch, CreditCard, PixLogo, Wallet as WalletIcon } from '@phosphor-icons/react'
import { api, brl, coins, newIdempotencyKey } from '../../lib/api.js'
import { useApi } from '../../lib/useApi.js'
import { useAuth } from '../../lib/auth.jsx'
import { FormAlert, Submit } from '../../components/form.jsx'
import { CopyButton } from './Home.jsx'
import { Coin, LoadError, PageHead, Skeleton } from './ui.jsx'

const METHODS = [
  { id: 'PIX', label: 'Pix', Icon: PixLogo },
  { id: 'CARD', label: 'Cartão', Icon: CreditCard },
  { id: 'BALANCE', label: 'Saldo em carteira', Icon: WalletIcon },
]

/** Acompanha a compra até o pagamento ser confirmado ou falhar. */
function PaymentWatch({ purchase: initial, onFinish }) {
  const [purchase, setPurchase] = useState(initial)
  const [simulating, setSimulating] = useState(false)
  const status = purchase.status
  const payment = purchase.payment ?? {}

  useEffect(() => {
    if (status !== 'PENDING_PAYMENT') {
      onFinish(purchase)
      return
    }
    const id = setInterval(async () => {
      try {
        const res = await api(`/me/getcoin-purchases/${purchase.id}`)
        setPurchase(res.data ?? res)
      } catch {
        /* tenta de novo no próximo ciclo */
      }
    }, 3000)
    return () => clearInterval(id)
  }, [status]) // eslint-disable-line react-hooks/exhaustive-deps

  async function simulate() {
    setSimulating(true)
    try {
      await api(`/payments/${payment.id}/simulate`, { method: 'POST', body: { status: 'PAID' } })
      const res = await api(`/me/getcoin-purchases/${purchase.id}`)
      setPurchase(res.data ?? res)
    } finally {
      setSimulating(false)
    }
  }

  if (status !== 'PENDING_PAYMENT') return null
  return (
    <div className="db-pix" aria-live="polite">
      <p className="db-pix-wait"><CircleNotch size={18} className="af-spin" aria-hidden="true" />Aguardando o pagamento de <b className="mono">{brl(purchase.package?.priceCents ?? 0)}</b></p>
      {payment.pixCopyPaste ? (
        <>
          <p className="dh-text">Copie o código Pix e pague no app do seu banco. Os GetCoins entram assim que o pagamento for confirmado.</p>
          <code className="db-pix-code mono">{payment.pixCopyPaste}</code>
          <CopyButton value={payment.pixCopyPaste} label="Copiar código Pix" />
        </>
      ) : (
        <p className="dh-text">Conclua o pagamento no cartão. Esta tela atualiza sozinha quando ele for confirmado.</p>
      )}
      {import.meta.env.DEV && payment.id && (
        <button type="button" className="btn btn-glass btn-sm db-sim" onClick={simulate} disabled={simulating}>
          Simular pagamento (só em desenvolvimento)
        </button>
      )}
    </div>
  )
}

export default function Buy() {
  const { user } = useAuth()
  const unverified = Boolean(user && !user.emailVerified)
  const packages = useApi('/getcoin-packages')
  const cash = useApi('/me/cash?pageSize=1')
  const [selected, setSelected] = useState(null)
  const [method, setMethod] = useState('PIX')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [purchase, setPurchase] = useState(null)
  const [done, setDone] = useState(null)
  const key = useRef(newIdempotencyKey())

  const [qty, setQty] = useState('') // compra avulsa: GetCoins inteiros
  const list = packages.data?.data ?? []
  // D11: compra avulsa com preço por GetCoin definido pelo admin
  const custom = packages.data?.custom
  const customOn = Boolean(custom?.enabled)
  const qtyCents = (parseInt(qty, 10) || 0) * 100
  const isCustom = selected === 'custom'
  const qtyError = isCustom && qty !== '' && (qtyCents < custom.minCents || qtyCents > custom.maxCents)
    ? `Escolha entre ${coins(custom.minCents)} e ${coins(custom.maxCents)} GetCoins.`
    : null
  const pkg = isCustom
    ? (qtyCents && !qtyError ? { name: 'Avulso', getcoinsCents: qtyCents, bonusCents: 0, priceCents: (qtyCents / 100) * custom.unitPriceCents } : null)
    : list.find((p) => p.id === selected) ?? null
  const balance = cash.data?.data?.balanceCents ?? 0
  const balanceShort = method === 'BALANCE' && pkg && pkg.priceCents > balance

  useEffect(() => {
    if (selected) return
    if (list.length) setSelected(list[0].id)
    else if (customOn) setSelected('custom')
  }, [list, selected, customOn])

  // Uma nova escolha é uma nova operação: troca a chave de idempotência.
  useEffect(() => { key.current = newIdempotencyKey() }, [selected, method, qty])

  async function submit(e) {
    e.preventDefault()
    if (!pkg || balanceShort || unverified) return
    setError(null)
    setDone(null)
    setBusy(true)
    try {
      const res = await api('/me/getcoin-purchases', {
        method: 'POST',
        body: isCustom ? { customGetcoinsCents: qtyCents, method } : { packageId: pkg.id, method },
        headers: { 'Idempotency-Key': key.current },
      })
      const p = res.data ?? res
      if (p.status === 'PAID') {
        setDone(p)
        cash.reload()
      } else setPurchase(p)
      key.current = newIdempotencyKey()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  function finish(p) {
    setPurchase(null)
    cash.reload()
    if (p.status === 'PAID') setDone(p)
    else setError('O pagamento não foi concluído. Nenhum valor foi cobrado; você pode tentar de novo.')
  }

  return (
    <div className="dp">
      <PageHead title="Comprar GetCoins" />

      {done && (
        <div className="af-alert af-alert-ok" role="status">
          <Check size={20} weight="bold" aria-hidden="true" />
          <div>
            Pronto! <b className="mono">{coins((done.package?.getcoinsCents ?? 0) + (done.package?.bonusCents ?? 0))}</b> GetCoins entraram na sua carteira.{' '}
            <Link to="/dashboard/carteira" className="af-inline-link">Ver extrato</Link>
          </div>
        </div>
      )}
      {packages.error ? <LoadError message={packages.error} onRetry={packages.reload} />
        : packages.loading && !packages.data ? (
          <section className="db-loading glass" aria-label="Carregando pacotes"><Skeleton lines={3} /></section>
        ) : list.length === 0 && !customOn ? (
          <section className="db-empty glass" aria-labelledby="db-empty-title">
            <Coin />
            <div className="db-empty-copy">
              <h2 id="db-empty-title" className="dh-section-title">Nenhum pacote disponível</h2>
              <p className="dh-text">Ainda não há pacotes de GetCoin à venda. Você pode atualizar a lista ou voltar para a carteira.</p>
            </div>
            <div className="db-empty-actions">
              <button type="button" className="btn btn-glass" onClick={packages.reload}>
                <ArrowClockwise size={18} aria-hidden="true" />Atualizar pacotes
              </button>
              <Link to="/dashboard/carteira" className="af-inline-link">Voltar para a carteira</Link>
            </div>
          </section>
        ) : (
      <form className="db-form" onSubmit={submit} aria-label="Comprar GetCoins">
        <fieldset className="db-packages" disabled={Boolean(purchase)}>
          <legend className="dh-section-title">{customOn ? 'Escolha um pacote ou a quantidade' : 'Escolha um pacote'}</legend>
          <div className="db-grid">
            {list.map((p) => (
              <label key={p.id} className={`db-pack glass ${selected === p.id ? 'is-selected' : ''}`}>
                <input type="radio" name="package" value={p.id} checked={selected === p.id} onChange={() => setSelected(p.id)} />
                <span className="db-pack-name">{p.name}</span>
                <span className="db-pack-coins"><Coin size="sm" /><span className="mono">{coins(p.getcoinsCents)}</span></span>
                {p.bonusCents > 0 && <span className="db-pack-bonus">+ <span className="mono">{coins(p.bonusCents)}</span> de bônus</span>}
                <span className="db-pack-price mono">{brl(p.priceCents)}</span>
              </label>
            ))}
            {customOn && (
              <div className={`db-pack db-pack-custom glass ${isCustom ? 'is-selected' : ''}`} onClick={() => setSelected('custom')}>
                <label className="db-pack-name" htmlFor="db-custom-qty">
                  <input type="radio" name="package" value="custom" checked={isCustom} onChange={() => setSelected('custom')} aria-label="Quantidade avulsa" />
                  Quantidade avulsa
                </label>
                <span className="db-custom-input">
                  <Coin size="sm" />
                  <input
                    id="db-custom-qty"
                    className="mono"
                    inputMode="numeric"
                    placeholder={String(custom.minCents / 100)}
                    value={qty}
                    onFocus={() => setSelected('custom')}
                    onChange={(e) => setQty(e.target.value.replace(/\D/g, '').slice(0, 7))}
                    aria-invalid={qtyError ? 'true' : undefined}
                    aria-describedby="db-custom-hint"
                  />
                </span>
                <span id="db-custom-hint" className={qtyError ? 'af-error' : 'db-pack-bonus'}>
                  {qtyError ?? <><span className="mono">{brl(custom.unitPriceCents)}</span> por GetCoin</>}
                </span>
                <span className="db-pack-price mono">{qtyCents && !qtyError ? brl((qtyCents / 100) * custom.unitPriceCents) : '—'}</span>
              </div>
            )}
          </div>
        </fieldset>

        <fieldset className="db-methods" disabled={Boolean(purchase)}>
          <legend className="dh-section-title">Forma de pagamento</legend>
          <div className="db-checkout glass">
          <div className="db-method-row">
            {METHODS.map((m) => (
              <label key={m.id} className={`db-method ${method === m.id ? 'is-selected' : ''}`}>
                <input type="radio" name="method" value={m.id} checked={method === m.id} onChange={() => setMethod(m.id)} />
                <m.Icon size={20} aria-hidden="true" />
                <span>{m.label}</span>
                {m.id === 'BALANCE' && <span className="mono db-method-bal">{brl(balance)}</span>}
              </label>
            ))}
          </div>

          {pkg && (
            <p className="db-summary">
              <span>Você recebe <b className="mono">{coins(pkg.getcoinsCents + (pkg.bonusCents ?? 0))}</b> GetCoins</span>
              <span>Total <b className="mono">{brl(pkg.priceCents)}</b></span>
            </p>
          )}
          {unverified && (
            <FormAlert>
              Confirme seu e-mail para comprar GetCoins. <Link to="/dashboard" className="af-inline-link">Reenviar o link</Link>
            </FormAlert>
          )}
          {balanceShort && <FormAlert>Seu saldo em carteira não cobre este pacote. Escolha Pix ou cartão.</FormAlert>}
          <FormAlert>{error}</FormAlert>

          {!purchase && (
            <Submit busy={busy} disabled={unverified || balanceShort || !pkg} busyLabel="Gerando pagamento…">{method === 'BALANCE' ? 'Comprar com saldo' : 'Ir para o pagamento'}</Submit>
          )}
          </div>
        </fieldset>
        {purchase && <PaymentWatch key={purchase.id} purchase={purchase} onFinish={finish} />}
      </form>
        )}
    </div>
  )
}
