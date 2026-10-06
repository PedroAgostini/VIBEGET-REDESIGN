import { useState } from 'react'
import { CircleNotch, Coins, Plus } from '@phosphor-icons/react'
import { api, brl, coins, fieldErrors } from '../../lib/api.js'
import { useApi } from '../../lib/useApi.js'
import { Field } from '../../components/form.jsx'
import { Coin, LoadError, PageHead, Skeleton } from '../dashboard/ui.jsx'
import { ConfirmAction, useIsAdmin } from './ui.jsx'

const MAX_CENTS = 10_000_000
const digits = (v) => String(v).replace(/\D/g, '')
const centsText = (c) => (c / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 })
const maskCents = (t) => (digits(t) ? centsText(parseInt(digits(t), 10)) : '')
const toCents = (t) => (digits(t) ? parseInt(digits(t), 10) : 0)

/** Preço de 1 GetCoin no pacote (contando o bônus), em centavos de R$. */
const perCoin = (p) => {
  const total = p.getcoinsCents + p.bonusCents
  return total ? (p.priceCents / total) * 100 : 0
}

/** Diferença para a compra avulsa, em %: negativo = mais barato. */
const vsCustom = (p, unitPriceCents) => (unitPriceCents ? Math.round((perCoin(p) / unitPriceCents - 1) * 100) : null)

function Comparison({ diff }) {
  if (diff == null || diff === 0) return null
  return <span className={diff < 0 ? 'pk-cheaper' : 'pk-pricier'}>{Math.abs(diff)}% {diff < 0 ? 'abaixo' : 'acima'} do avulso</span>
}

function PackageForm({ pack, onDone, onCancel, unitPriceCents }) {
  const editing = Boolean(pack)
  const [v, setV] = useState({
    name: pack?.name ?? '',
    getcoins: pack ? centsText(pack.getcoinsCents) : '',
    bonus: pack?.bonusCents ? centsText(pack.bonusCents) : '',
    price: pack ? centsText(pack.priceCents) : '',
    sortOrder: String(pack?.sortOrder ?? 0),
    active: pack?.active ?? true,
  })
  const [errors, setErrors] = useState({})
  const [alert, setAlert] = useState(null)
  const [busy, setBusy] = useState(false)
  const set = (key) => (value) => { setV((s) => ({ ...s, [key]: value })); setErrors((e) => ({ ...e, [key]: undefined })) }

  const draft = { getcoinsCents: toCents(v.getcoins), bonusCents: toCents(v.bonus), priceCents: toCents(v.price) }

  function validate() {
    const e = {}
    if (v.name.trim().length < 2) e.name = 'De 2 a 80 caracteres.'
    if (!draft.getcoinsCents) e.getcoinsCents = 'Informe quantos GetCoins o pacote dá.'
    else if (draft.getcoinsCents > MAX_CENTS) e.getcoinsCents = `O máximo é ${coins(MAX_CENTS)}.`
    if (draft.bonusCents > MAX_CENTS) e.bonusCents = `O máximo é ${coins(MAX_CENTS)}.`
    if (!draft.priceCents) e.priceCents = 'Informe o preço.'
    else if (draft.priceCents > MAX_CENTS) e.priceCents = `O máximo é ${brl(MAX_CENTS)}.`
    if (parseInt(v.sortOrder || '0', 10) > 10_000) e.sortOrder = 'De 0 a 10.000.'
    return e
  }

  async function submit(ev) {
    ev.preventDefault()
    const found = validate()
    setErrors(found)
    if (Object.keys(found).length) return
    const full = { name: v.name.trim(), ...draft, sortOrder: parseInt(v.sortOrder || '0', 10), active: v.active }
    // Na edição, manda só o que mudou.
    const body = editing ? Object.fromEntries(Object.entries(full).filter(([k, val]) => val !== pack[k])) : full
    if (editing && !Object.keys(body).length) { onCancel(); return }
    setBusy(true)
    setAlert(null)
    try {
      await api(editing ? `/admin/getcoin-packages/${pack.id}` : '/admin/getcoin-packages', { method: editing ? 'PATCH' : 'POST', body })
      onDone()
    } catch (err) {
      const byField = fieldErrors(err)
      if (Object.keys(byField).length) setErrors(byField)
      else setAlert(err.message)
      setBusy(false)
    }
  }

  return (
    <form className={editing ? 'cp-form pk-edit' : 'ad-panel glass cp-form'} onSubmit={submit} noValidate aria-label={editing ? `Editar ${pack.name}` : 'Novo pacote'}>
      {!editing && <h2 className="dh-section-title">Novo pacote</h2>}
      <div className="cp-grid">
        <Field label="Nome" value={v.name} maxLength={80} onChange={(e) => set('name')(e.target.value)} error={errors.name} placeholder="Ex.: Pacote 100" />
        <Field label="GetCoins" inputMode="numeric" placeholder="0,00" className="af-input mono" value={v.getcoins} onChange={(e) => set('getcoins')(maskCents(e.target.value))} error={errors.getcoinsCents} />
        <Field label="Bônus em GetCoins" inputMode="numeric" placeholder="0,00" className="af-input mono" value={v.bonus} onChange={(e) => set('bonus')(maskCents(e.target.value))} error={errors.bonusCents} hint="Opcional. Aparece como “+ bônus” na compra." />
        <Field label="Preço" inputMode="numeric" placeholder="0,00" className="af-input mono" value={v.price} onChange={(e) => set('price')(maskCents(e.target.value))} error={errors.priceCents} aside={<span className="st-unit">R$</span>} />
        <Field label="Ordem na vitrine" inputMode="numeric" className="af-input mono" value={v.sortOrder} onChange={(e) => set('sortOrder')(digits(e.target.value).slice(0, 5))} error={errors.sortOrder} hint="Menor aparece primeiro." />
      </div>
      {draft.getcoinsCents > 0 && draft.priceCents > 0 && (
        <p className="pk-preview">
          A pessoa paga <b className="mono">{brl(draft.priceCents)}</b> e recebe <b className="mono">{coins(draft.getcoinsCents + draft.bonusCents)}</b> GetCoins:
          {' '}<span className="mono">{brl(perCoin(draft))}</span> por GetCoin. <Comparison diff={vsCustom(draft, unitPriceCents)} />
        </p>
      )}
      <label className="toggle pk-toggle">
        <input type="checkbox" checked={v.active} onChange={(e) => set('active')(e.target.checked)} />
        <span className="switch" aria-hidden="true" />
        <span><b>À venda</b><span className="st-hint">Desligado, o pacote some da tela Comprar GetCoins.</span></span>
      </label>
      {editing && pack.paidCount > 0 && <p className="ad-item-note">Quem já comprou fica com os valores da compra. A mudança vale só para as próximas.</p>}
      {alert && <p className="af-error" role="alert">{alert}</p>}
      <div className="ad-confirm-actions">
        <button type="button" className="btn btn-sm btn-glass" onClick={onCancel} disabled={busy}>Cancelar</button>
        <button type="submit" className="btn btn-sm btn-coin" disabled={busy} aria-busy={busy}>
          {busy && <CircleNotch size={16} className="af-spin" aria-hidden="true" />}
          {editing ? 'Salvar pacote' : 'Criar pacote'}
        </button>
      </div>
    </form>
  )
}

function PackageCard({ p, unitPriceCents, onChanged }) {
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  async function toggle() {
    setBusy(true)
    setError(null)
    try {
      await api(`/admin/getcoin-packages/${p.id}`, { method: 'PATCH', body: { active: !p.active } })
      onChanged()
    } catch (err) {
      setError(err.message)
      setBusy(false)
    }
  }
  const remove = async () => {
    await api(`/admin/getcoin-packages/${p.id}`, { method: 'DELETE' })
    onChanged()
  }
  const unpaid = p.purchasesCount - p.paidCount

  return (
    <li className={`ad-item glass pk-card ${p.active ? '' : 'is-paused'}`}>
      <div className="cp-head">
        <div className="pk-title">
          <span className="pk-coin"><Coin /></span>
          <span className="ad-user-main">
            <span className="ad-who-name">{p.name}</span>
            <span className="ad-who-meta">Ordem <span className="mono">{p.sortOrder}</span> na vitrine</span>
          </span>
        </div>
        <span className={`dg-pill dg-pill-${p.active ? 'ok' : 'off'}`}>{p.active ? 'À venda' : 'Fora da vitrine'}</span>
      </div>
      <dl className="cp-figs">
        <div><dt>GetCoins</dt><dd className="mono cp-amount">{coins(p.getcoinsCents)}{p.bonusCents > 0 && <span> + {coins(p.bonusCents)} bônus</span>}</dd></div>
        <div><dt>Preço</dt><dd className="mono">{brl(p.priceCents)}</dd></div>
        <div><dt>Por GetCoin</dt><dd><span className="mono">{brl(perCoin(p))}</span> <Comparison diff={vsCustom(p, unitPriceCents)} /></dd></div>
        <div><dt>Vendas pagas</dt><dd><span className="mono">{p.paidCount}</span>{unpaid > 0 && <span className="ad-who-meta"> · {unpaid} sem pagamento</span>}</dd></div>
      </dl>

      {editing ? (
        <PackageForm pack={p} unitPriceCents={unitPriceCents} onDone={() => { setEditing(false); onChanged() }} onCancel={() => setEditing(false)} />
      ) : (
        <div className="ad-item-actions">
          {error && <p className="af-error" role="alert">{error}</p>}
          {p.purchasesCount === 0 && (
            <ConfirmAction label="Excluir" tone="danger" confirmLabel="Excluir pacote" warning="Nunca foi comprado, então pode ser apagado de vez." onConfirm={remove} />
          )}
          <button type="button" className="btn btn-sm btn-glass" onClick={() => setEditing(true)}>Editar</button>
          <button type="button" className={`btn btn-sm ${p.active ? 'btn-glass' : 'btn-coin'}`} onClick={toggle} disabled={busy} aria-busy={busy}>
            {busy && <CircleNotch size={16} className="af-spin" aria-hidden="true" />}
            {p.active ? 'Tirar da vitrine' : 'Pôr à venda'}
          </button>
        </div>
      )}
    </li>
  )
}

export default function Packages() {
  const isAdmin = useIsAdmin()
  const list = useApi(isAdmin ? '/admin/getcoin-packages' : null)
  const settings = useApi(isAdmin ? '/admin/settings/getcoin' : null)
  const [creating, setCreating] = useState(false)
  const unitPriceCents = settings.data?.data?.getcoinUnitPriceCents
  const rows = list.data?.data ?? []

  if (!isAdmin) {
    return (
      <div className="dp">
        <PageHead title="Pacotes de GetCoin" />
        <p className="ad-readonly">Os pacotes ficam só com o administrador.</p>
      </div>
    )
  }
  return (
    <div className="dp">
      <PageHead title="Pacotes de GetCoin">
        {!creating && <button type="button" className="btn btn-sm btn-coin" onClick={() => setCreating(true)}><Plus size={16} weight="bold" aria-hidden="true" /> Novo pacote</button>}
      </PageHead>
      {creating && <PackageForm unitPriceCents={unitPriceCents} onDone={() => { setCreating(false); list.reload() }} onCancel={() => setCreating(false)} />}
      {list.error ? <LoadError message={list.error} onRetry={list.reload} />
        : !list.data ? <Skeleton lines={5} />
          : rows.length === 0 ? (
            <div className="dg-onboarding glass">
              <Coins size={32} weight="duotone" aria-hidden="true" />
              <div className="dg-onboarding-copy">
                <h2 className="dh-section-title">Nenhum pacote ainda</h2>
                <p className="dh-text">Sem pacotes, a tela Comprar GetCoins mostra só a compra avulsa (se estiver ligada).</p>
              </div>
            </div>
          ) : (
            <ul className="ad-list">{rows.map((p) => <PackageCard key={`${p.id}-${p.updatedAt}`} p={p} unitPriceCents={unitPriceCents} onChanged={list.reload} />)}</ul>
          )}
    </div>
  )
}
