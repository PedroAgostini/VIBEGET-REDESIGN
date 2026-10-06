import { useState } from 'react'
import { ArrowsLeftRight, CircleNotch, ClockCounterClockwise, Coins, Gift, Money } from '@phosphor-icons/react'
import { api, brl, coins, fieldErrors } from '../../lib/api.js'
import { useApi } from '../../lib/useApi.js'
import { Field } from '../../components/form.jsx'
import { LoadError, PageHead, Skeleton, dateFmt } from '../dashboard/ui.jsx'
import { useIsAdmin } from './ui.jsx'

/*
 * Cada campo tem um "kind" que diz como o valor inteiro da API vira texto no campo e volta:
 * brl (centavos de R$), coins (centavos de GetCoin), whole (GetCoins inteiros, múltiplos de 100),
 * int (número puro com unidade) e toggle (liga/desliga).
 */
const digits = (v) => String(v).replace(/\D/g, '')
const centsText = (c) => (c / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 })
const centsKind = (show) => ({
  toText: centsText,
  toValue: (t) => (digits(t) ? parseInt(digits(t), 10) : null),
  mask: (t) => (digits(t) ? centsText(parseInt(digits(t), 10)) : ''),
  show,
})
const KINDS = {
  brl: centsKind(brl),
  coins: centsKind((c) => `${coins(c)} GetCoins`),
  whole: { toText: (c) => String(c / 100), toValue: (t) => (digits(t) ? parseInt(digits(t), 10) * 100 : null), mask: (t) => digits(t).slice(0, 7), show: (c) => `${(c / 100).toLocaleString('pt-BR')} GetCoins` },
  int: { toText: (n) => String(n), toValue: (t) => (digits(t) ? parseInt(digits(t), 10) : null), mask: (t) => digits(t).slice(0, 4), show: (n) => String(n) },
  toggle: { toText: (b) => b, toValue: (b) => b, show: (b) => (b ? 'ligado' : 'desligado') },
}

const GROUPS = [
  {
    id: 'geral', path: '/admin/settings', title: 'Bônus e Vibes', Icon: Gift,
    fields: [
      { key: 'welcomeBonusCents', label: 'Bônus de boas-vindas', kind: 'coins', max: 100_000, hint: 'GetCoins que toda conta nova recebe. Zero desliga.' },
      { key: 'referralBonusCents', label: 'Bônus de indicação', kind: 'coins', max: 100_000, hint: 'GetCoins para quem indicou, quando o amigo entra.' },
      { key: 'defaultCashbackPercent', label: 'Cashback padrão', kind: 'int', unit: '%', max: 100, hint: 'Quanto volta em GetCoin para quem não vence, se a Vibe não definir outro.' },
      { key: 'getCutoffSeconds', label: 'Corte de Gets antes do fim', kind: 'int', unit: 's', max: 3600, hint: 'Novos Gets param este tempo antes do fim da Vibe.' },
      { key: 'paymentGraceSeconds', label: 'Prazo para confirmar o pagamento', kind: 'int', unit: 's', max: 3600, hint: 'Depois do corte, quanto tempo um Pix ainda pode confirmar. Precisa caber no corte.' },
    ],
  },
  {
    id: 'saques', path: '/admin/settings/withdrawals', title: 'Saques', Icon: Money,
    fields: [
      { key: 'withdrawMinCents', label: 'Saque mínimo', kind: 'brl', min: 1, max: 10_000_000 },
      { key: 'withdrawDailyMaxCents', label: 'Limite por dia', kind: 'brl', min: 1, max: 100_000_000, hint: 'Soma dos saques de uma pessoa nas últimas 24 horas.' },
    ],
  },
  {
    id: 'getcoin', path: '/admin/settings/getcoin', title: 'Compra de GetCoin', Icon: Coins,
    fields: [
      { key: 'getcoinUnitPriceCents', label: 'Preço de 1 GetCoin', kind: 'brl', min: 1, max: 100_000, hint: 'Usado na compra avulsa. Os pacotes têm preço próprio.' },
      { key: 'getcoinCustomEnabled', label: 'Compra avulsa', kind: 'toggle', hint: 'Deixa a pessoa escolher a quantidade, além dos pacotes.' },
      { key: 'getcoinCustomMinCents', label: 'Mínimo na compra avulsa', kind: 'whole', unit: 'GetCoins', min: 100, max: 100_000_000 },
      { key: 'getcoinCustomMaxCents', label: 'Máximo na compra avulsa', kind: 'whole', unit: 'GetCoins', min: 100, max: 100_000_000 },
    ],
  },
  {
    id: 'market', path: '/admin/settings/market', title: 'Marketplace', Icon: ArrowsLeftRight,
    fields: [
      { key: 'marketEnabled', label: 'Marketplace aberto', kind: 'toggle', hint: 'Fechado, ninguém anuncia nem compra. Anúncios ativos continuam guardados.' },
      { key: 'marketFeePercent', label: 'Taxa sobre a venda', kind: 'int', unit: '%', max: 50, hint: 'Descontada do vendedor, em GetCoin.' },
      { key: 'marketMinUnitPriceCents', label: 'Preço mínimo por GetCoin', kind: 'brl', min: 1, max: 100_000 },
      { key: 'marketMaxUnitPriceCents', label: 'Preço máximo por GetCoin', kind: 'brl', min: 1, max: 100_000 },
      { key: 'marketMinListingCents', label: 'Anúncio mínimo', kind: 'whole', unit: 'GetCoins', min: 100, max: 100_000_000 },
      { key: 'marketMaxPendingOrders', label: 'Pedidos em aberto por comprador', kind: 'int', min: 1, max: 20, hint: 'Evita que alguém reserve GetCoins de vários anúncios sem pagar.' },
      { key: 'marketOrderTtlMinutes', label: 'Prazo para pagar um pedido', kind: 'int', unit: 'min', min: 1, max: 60 },
    ],
  },
]
const FIELD = Object.fromEntries(GROUPS.flatMap((g) => g.fields.map((f) => [f.key, f])))
const fmtValue = (f, v) => `${KINDS[f.kind].show(v)}${f.unit && f.kind === 'int' ? ` ${f.unit}` : ''}`

/** Regras entre campos (as mesmas da API), com texto para quem administra. */
function crossErrors(v) {
  const e = {}
  const over = (a, b) => v[a] != null && v[b] != null && v[a] > v[b]
  if (over('paymentGraceSeconds', 'getCutoffSeconds')) e.paymentGraceSeconds = 'Não pode ser maior que o corte de Gets.'
  if (over('withdrawMinCents', 'withdrawDailyMaxCents')) e.withdrawMinCents = 'Não pode ser maior que o limite por dia.'
  if (over('getcoinCustomMinCents', 'getcoinCustomMaxCents')) e.getcoinCustomMinCents = 'Não pode ser maior que o máximo.'
  if (over('marketMinUnitPriceCents', 'marketMaxUnitPriceCents')) e.marketMinUnitPriceCents = 'Não pode ser maior que o preço máximo.'
  return e
}

function SettingsGroup({ group, saved, onSaved }) {
  const initial = Object.fromEntries(group.fields.map((f) => [f.key, KINDS[f.kind].toText(saved[f.key])]))
  const [text, setText] = useState(initial)
  const [errors, setErrors] = useState({})
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [alert, setAlert] = useState(null)

  const values = Object.fromEntries(group.fields.map((f) => [f.key, KINDS[f.kind].toValue(text[f.key])]))
  const changed = group.fields.filter((f) => values[f.key] !== saved[f.key])
  const set = (key, value) => {
    setText((t) => ({ ...t, [key]: value }))
    setConfirming(false)
    setErrors((e) => ({ ...e, [key]: undefined }))
  }

  function validate() {
    const found = {}
    for (const f of group.fields) {
      if (f.kind === 'toggle') continue
      const v = values[f.key]
      if (v == null) found[f.key] = 'Preencha o valor.'
      else if (v < (f.min ?? 0)) found[f.key] = `O mínimo é ${fmtValue(f, f.min)}.`
      else if (v > f.max) found[f.key] = `O máximo é ${fmtValue(f, f.max)}.`
    }
    return { ...crossErrors(values), ...found }
  }

  async function submit(e) {
    e.preventDefault()
    if (!confirming) {
      const found = validate()
      setErrors(found)
      if (!Object.keys(found).length && changed.length) setConfirming(true)
      return
    }
    setBusy(true)
    setAlert(null)
    try {
      await api(group.path, { method: 'PATCH', body: Object.fromEntries(changed.map((f) => [f.key, values[f.key]])) })
      onSaved()
    } catch (err) {
      const byField = fieldErrors(err)
      if (Object.keys(byField).length) { setErrors(byField); setConfirming(false) } else setAlert(err.message)
      setBusy(false)
    }
  }

  return (
    <form className="ad-panel glass st-group" onSubmit={submit} noValidate aria-labelledby={`st-${group.id}`}>
      <h2 className="dh-section-title" id={`st-${group.id}`}><group.Icon size={20} aria-hidden="true" /> {group.title}</h2>
      <div className="st-fields">
        {group.fields.map((f) => (f.kind === 'toggle' ? (
          <label key={f.key} className="toggle st-toggle">
            <input type="checkbox" checked={text[f.key]} onChange={(e) => set(f.key, e.target.checked)} />
            <span className="switch" aria-hidden="true" />
            <span>
              <b>{f.label}</b>
              {f.hint && <span className="st-hint">{f.hint}</span>}
            </span>
          </label>
        ) : (
          <Field
            key={f.key}
            label={f.label} inputMode="numeric" className="af-input mono"
            value={text[f.key]} onChange={(e) => set(f.key, KINDS[f.kind].mask(e.target.value))}
            error={errors[f.key]} hint={f.hint}
            aside={<span className="st-unit">{f.unit ?? { brl: 'R$', coins: 'GetCoins' }[f.kind] ?? ''}</span>}
          />
        )))}
      </div>
      {confirming ? (
        <div className="ad-confirm st-confirm" role="group" aria-label="Confirmar alterações">
          <ul className="st-diff">
            {changed.map((f) => (
              <li key={f.key}><span>{f.label}</span><span className="mono">{fmtValue(f, saved[f.key])} → {fmtValue(f, values[f.key])}</span></li>
            ))}
          </ul>
          <p className="ad-confirm-text">Vale na hora para todo mundo e fica registrado no histórico.</p>
          {alert && <p className="af-error" role="alert">{alert}</p>}
          <div className="ad-confirm-actions">
            <button type="button" className="btn btn-sm btn-glass" onClick={() => setConfirming(false)} disabled={busy}>Voltar</button>
            <button type="submit" className="btn btn-sm btn-coin" disabled={busy} aria-busy={busy}>
              {busy && <CircleNotch size={16} className="af-spin" aria-hidden="true" />}
              Confirmar
            </button>
          </div>
        </div>
      ) : changed.length > 0 && (
        <div className="ad-confirm-actions">
          <button type="button" className="btn btn-sm btn-glass" onClick={() => { setText(initial); setErrors({}) }}>Desfazer</button>
          <button type="submit" className="btn btn-sm btn-coin">Revisar {changed.length === 1 ? '1 alteração' : `${changed.length} alterações`}</button>
        </div>
      )}
    </form>
  )
}

function GroupLoader({ group, onSaved }) {
  const res = useApi(group.path)
  const [savedAt, setSavedAt] = useState(null)
  if (res.error) return <div className="ad-panel glass"><LoadError message={res.error} onRetry={res.reload} /></div>
  if (!res.data) return <div className="ad-panel glass"><Skeleton lines={4} /></div>
  const saved = res.data.data
  // A chave muda com os valores salvos: depois do reload, o formulário recomeça limpo.
  return (
    <div className="st-slot">
      <SettingsGroup key={JSON.stringify(saved)} group={group} saved={saved} onSaved={() => { res.reload(); setSavedAt(Date.now()); onSaved() }} />
      {savedAt && <p className="ad-done st-saved" role="status">{group.title}: alterações salvas.</p>}
    </div>
  )
}

function History() {
  const logs = useApi('/admin/audit-logs?entity=settings&pageSize=8')
  const rows = logs.data?.data ?? []
  return (
    <section className="ad-panel glass" aria-labelledby="st-history">
      <h2 className="dh-section-title" id="st-history"><ClockCounterClockwise size={20} aria-hidden="true" /> Últimas alterações</h2>
      {logs.error ? <LoadError message={logs.error} onRetry={logs.reload} />
        : !logs.data ? <Skeleton lines={3} />
          : rows.length === 0 ? <p className="ad-item-note">Nenhuma configuração foi alterada ainda: tudo está nos valores iniciais.</p>
            : (
              <ol className="ad-log">
                {rows.map((l) => (
                  <li key={l.id}>
                    <ClockCounterClockwise size={16} aria-hidden="true" />
                    <div>
                      {Object.entries(l.metadata?.changes ?? {}).map(([k, c]) => (
                        <p key={k} className="ad-log-title">
                          {FIELD[k]?.label ?? k} · <span className="mono">{FIELD[k] ? `${fmtValue(FIELD[k], c.from)} → ${fmtValue(FIELD[k], c.to)}` : `${c.from} → ${c.to}`}</span>
                        </p>
                      ))}
                      <p className="ad-who-meta"><span className="mono">{dateFmt.format(new Date(l.createdAt))}</span>{l.actorName ? ` · por ${l.actorName}` : ''}</p>
                    </div>
                  </li>
                ))}
              </ol>
            )}
    </section>
  )
}

export default function Settings() {
  const isAdmin = useIsAdmin()
  const [version, setVersion] = useState(0)
  if (!isAdmin) {
    return (
      <div className="dp">
        <PageHead title="Configurações" />
        <p className="ad-readonly">As configurações ficam só com o administrador.</p>
      </div>
    )
  }
  return (
    <div className="dp">
      <PageHead title="Configurações" />
      <div className="st-grid">
        {GROUPS.map((g) => <GroupLoader key={g.id} group={g} onSaved={() => setVersion((v) => v + 1)} />)}
      </div>
      <History key={version} />
    </div>
  )
}
