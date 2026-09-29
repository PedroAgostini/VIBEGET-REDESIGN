import { useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { motion } from 'framer-motion'
import { Check, CircleNotch, MapPin, Package, Trophy, Truck } from '@phosphor-icons/react'
import { api, brl, fieldErrors } from '../../lib/api.js'
import { useApi } from '../../lib/useApi.js'
import { useAuth } from '../../lib/auth.jsx'
import { Field, FormAlert, Submit } from '../../components/form.jsx'
import { CopyButton } from './Home.jsx'
import { LoadError, Skeleton, dayFmt } from './ui.jsx'

const ease = [0.16, 1, 0.3, 1]
const UFS = ['AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG', 'PA', 'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO']
const STEPS = [
  ['won', 'Você venceu'],
  ['address', 'Endereço confirmado'],
  ['shipped', 'Enviado'],
  ['delivered', 'Entregue'],
]
const REACHED = { AWAITING_ADDRESS: 1, PREPARING: 2, SHIPPED: 3, DELIVERED: 4 }

const digits = (v = '') => v.replace(/\D/g, '')
const maskCep = (v) => digits(v).slice(0, 8).replace(/^(\d{5})(\d)/, '$1-$2')
const maskPhone = (v) => {
  const d = digits(v).slice(0, 11)
  if (d.length <= 2) return d
  if (d.length <= 6) return `(${d.slice(0, 2)}) ${d.slice(2)}`
  if (d.length <= 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`
  return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`
}
const oneLine = (a) => [
  `${a.street}, ${a.number}${a.complement ? ` · ${a.complement}` : ''}`,
  `${a.district} · ${a.city}/${a.state} · CEP ${maskCep(a.cep)}`,
]

function Timeline({ status }) {
  const reached = REACHED[status] ?? 1
  return (
    <ol className="pz-steps" aria-label="Andamento da entrega">
      {STEPS.map(([id, label], i) => {
        const done = i < reached
        const current = i === reached - 1
        return (
          <li key={id} className={`${done ? 'is-done' : ''} ${current ? 'is-current' : ''}`} aria-current={current ? 'step' : undefined}>
            <span className="pz-dot" aria-hidden="true">{done ? <Check size={12} weight="bold" /> : null}</span>
            <span className="pz-step-label">{label}</span>
          </li>
        )
      })}
    </ol>
  )
}

function AddressForm({ prize, onSaved, onCancel }) {
  const { user } = useAuth()
  const from = prize.address ?? user?.address ?? {}
  const [v, setV] = useState({
    recipientName: prize.recipientName ?? user?.name ?? '',
    phone: maskPhone(prize.phone ?? user?.phone ?? ''),
    cep: from.cep ? maskCep(from.cep) : '',
    street: from.street ?? '',
    number: from.number ?? '',
    complement: from.complement ?? '',
    district: from.district ?? '',
    city: from.city ?? '',
    state: from.state ?? '',
  })
  const [errors, setErrors] = useState({})
  const [alert, setAlert] = useState(null)
  const [busy, setBusy] = useState(false)
  const [lookup, setLookup] = useState('idle')
  const lastCep = useRef(digits(from.cep ?? ''))
  const numberRef = useRef(null)
  const set = (k, mask) => (e) => setV((s) => ({ ...s, [k]: mask ? mask(e.target.value) : e.target.value }))

  useEffect(() => {
    const cep = digits(v.cep)
    if (cep.length !== 8 || cep === lastCep.current) return
    lastCep.current = cep
    let alive = true
    setLookup('busy')
    api(`/cep/${cep}`)
      .then((res) => {
        if (!alive) return
        const r = res?.data ?? res
        setV((s) => ({ ...s, street: r.street || s.street, district: r.district || s.district, city: r.city ?? '', state: r.state ?? '' }))
        setLookup('idle')
        setErrors((e) => ({ ...e, cep: undefined }))
        setTimeout(() => numberRef.current?.focus(), 0)
      })
      .catch((err) => {
        if (!alive) return
        lastCep.current = ''
        setLookup('idle')
        setErrors((e) => ({ ...e, cep: err.status === 404 ? 'CEP não encontrado. Confira ou preencha o endereço à mão.' : err.message }))
      })
    return () => { alive = false }
  }, [v.cep])

  async function submit(e) {
    e.preventDefault()
    setAlert(null)
    const found = {}
    if (v.recipientName.trim().length < 3) found.recipientName = 'Informe o nome de quem vai receber.'
    if (!/^\d{10,11}$/.test(digits(v.phone))) found.phone = 'Informe um celular com DDD.'
    if (digits(v.cep).length !== 8) found.cep = 'Informe um CEP com 8 dígitos.'
    if (!v.street.trim()) found.street = 'Informe a rua.'
    if (!v.number.trim()) found.number = 'Informe o número.'
    if (!v.district.trim()) found.district = 'Informe o bairro.'
    if (!v.city.trim()) found.city = 'Informe a cidade.'
    if (!UFS.includes(v.state)) found.state = 'Escolha o estado.'
    setErrors(found)
    if (Object.keys(found).length) return
    setBusy(true)
    try {
      const body = { ...Object.fromEntries(Object.entries(v).map(([k, x]) => [k, x.trim()])), cep: digits(v.cep), phone: digits(v.phone) }
      if (!body.complement) delete body.complement
      const res = await api(`/me/prizes/${prize.id}/address`, { method: 'PUT', body })
      onSaved(res.data)
    } catch (err) {
      const byField = fieldErrors(err)
      if (Object.keys(byField).length) setErrors(byField)
      else setAlert(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <motion.form
      className="af-form dc-form pz-form" onSubmit={submit} noValidate aria-label="Endereço de entrega do prêmio"
      initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} transition={{ duration: 0.3, ease }}
    >
      <FormAlert>{alert}</FormAlert>
      <div className="dc-grid">
        <Field label="Quem vai receber" autoComplete="name" value={v.recipientName} onChange={set('recipientName')} error={errors.recipientName} />
        <Field label="Celular para contato" type="tel" inputMode="tel" autoComplete="tel-national" placeholder="(11) 99999-9999" value={v.phone} onChange={set('phone', maskPhone)} error={errors.phone} />
      </div>
      <div className="pz-cep">
        <Field
          label="CEP" inputMode="numeric" autoComplete="postal-code" placeholder="00000-000" value={v.cep} onChange={set('cep', maskCep)}
          error={errors.cep} hint={lookup === 'busy' ? 'Buscando endereço…' : 'Digite o CEP e preenchemos o resto.'}
        />
        <span className="pz-cep-state" aria-hidden="true">{lookup === 'busy' ? <CircleNotch size={18} className="af-spin" /> : <MapPin size={18} />}</span>
      </div>
      <div className="dc-grid dc-grid-address">
        <Field label="Rua" autoComplete="address-line1" value={v.street} onChange={set('street')} error={errors.street} />
        <div className="af-field">
          <div className="af-label-row"><label htmlFor={`pz-number-${prize.id}`}>Número</label></div>
          <input id={`pz-number-${prize.id}`} ref={numberRef} className="af-input" autoComplete="address-line2" value={v.number} onChange={set('number')} aria-invalid={errors.number ? 'true' : undefined} />
          {errors.number && <p className="af-error">{errors.number}</p>}
        </div>
        <Field label="Complemento" placeholder="Apto, bloco (opcional)" value={v.complement} onChange={set('complement')} error={errors.complement} />
        <Field label="Bairro" value={v.district} onChange={set('district')} error={errors.district} />
        <Field label="Cidade" autoComplete="address-level2" value={v.city} onChange={set('city')} error={errors.city} />
        <div className="af-field">
          <div className="af-label-row"><label htmlFor={`pz-uf-${prize.id}`}>Estado</label></div>
          <select id={`pz-uf-${prize.id}`} className="af-input af-select" value={v.state} onChange={set('state')} aria-invalid={errors.state ? 'true' : undefined}>
            <option value="">UF</option>
            {UFS.map((uf) => <option key={uf} value={uf}>{uf}</option>)}
          </select>
          {errors.state && <p className="af-error">{errors.state}</p>}
        </div>
      </div>
      <div className="dc-row-actions">
        {onCancel && <button type="button" className="btn btn-glass" onClick={onCancel} disabled={busy}>Cancelar</button>}
        <Submit busy={busy} busyLabel="Salvando…">Confirmar endereço</Submit>
      </div>
    </motion.form>
  )
}

function PrizeCard({ prize: initial }) {
  const [prize, setPrize] = useState(initial)
  const [editing, setEditing] = useState(initial.status === 'AWAITING_ADDRESS')
  const [saved, setSaved] = useState(false)
  const canEdit = prize.status === 'AWAITING_ADDRESS' || prize.status === 'PREPARING'
  const p = prize.product

  return (
    <li className={`pz-card glass ${prize.status === 'AWAITING_ADDRESS' ? 'is-pending' : ''}`}>
      <div className="pz-head">
        <div className="pz-plate">
          {p.imageUrl ? <img src={p.imageUrl} alt="" loading="lazy" /> : <Package size={36} weight="duotone" aria-hidden="true" />}
        </div>
        <div className="pz-info">
          <p className="pz-badge"><Trophy size={14} weight="fill" aria-hidden="true" />Champion Get</p>
          <h3 className="pz-name">{p.name}</h3>
          <p className="pz-meta">
            Get vencedor <b className="mono">{brl(prize.winningGetCents)}</b>
            {p.originalPriceCents ? <> · na loja <s className="mono">{brl(p.originalPriceCents)}</s></> : null}
          </p>
          <Timeline status={prize.status} />
        </div>
      </div>

      <div className="pz-body">
        {saved && <FormAlert tone="ok">Endereço confirmado. Avisamos por aqui quando o prêmio sair para entrega.</FormAlert>}

        {prize.status === 'AWAITING_ADDRESS' && editing && (
          <>
            <p className="dh-text">Parabéns! Confirme para onde enviar o seu prêmio. Você pode alterar o endereço até ele sair para entrega.</p>
            <AddressForm prize={prize} onSaved={(d) => { setPrize(d); setEditing(false); setSaved(true) }} />
          </>
        )}

        {prize.address && prize.status !== 'AWAITING_ADDRESS' && !editing && (
          <div className="pz-address">
            <MapPin size={18} aria-hidden="true" />
            <div>
              <p className="pz-address-who">{prize.recipientName} · <span className="mono">{maskPhone(prize.phone ?? '')}</span></p>
              {oneLine(prize.address).map((l) => <p key={l} className="pz-address-line">{l}</p>)}
            </div>
            {canEdit && <button type="button" className="btn btn-glass btn-sm" onClick={() => { setEditing(true); setSaved(false) }}>Alterar</button>}
          </div>
        )}
        {prize.status === 'PREPARING' && editing && (
          <AddressForm prize={prize} onSaved={(d) => { setPrize(d); setEditing(false); setSaved(true) }} onCancel={() => setEditing(false)} />
        )}

        {prize.status === 'PREPARING' && !editing && (
          <p className="pz-note">Estamos preparando o envio. O código de rastreio aparece aqui assim que o prêmio sair.</p>
        )}
        {prize.status === 'SHIPPED' && (
          <div className="pz-track">
            <Truck size={20} aria-hidden="true" />
            <div>
              <p className="pz-track-label">Enviado por {prize.carrier} em {dayFmt.format(new Date(prize.shippedAt))}</p>
              <p className="mono pz-track-code">{prize.trackingCode}</p>
            </div>
            <CopyButton value={prize.trackingCode} label="Copiar rastreio" />
          </div>
        )}
        {prize.status === 'DELIVERED' && (
          <p className="pz-note is-done"><Check size={16} weight="bold" aria-hidden="true" />Entregue em {dayFmt.format(new Date(prize.deliveredAt))}. Aproveite!</p>
        )}
      </div>
    </li>
  )
}

/** Prêmios do usuário (Champion Gets) com a entrega. Não aparece para quem nunca venceu. */
export default function PrizesSection() {
  const prizes = useApi('/me/prizes')
  const rows = prizes.data?.data ?? []
  const { hash } = useLocation()
  const ref = useRef(null)
  useEffect(() => {
    if (hash === '#premios' && rows.length) ref.current?.scrollIntoView({ block: 'start' })
  }, [hash, rows.length])
  if (prizes.loading && !prizes.data) return <Skeleton lines={2} />
  if (prizes.error) return <LoadError message={prizes.error} onRetry={prizes.reload} />
  if (rows.length === 0) return null
  return (
    <section className="dg-section" id="premios" ref={ref} aria-labelledby="pz-title">
      <h2 id="pz-title" className="dh-section-title">
        <Trophy size={20} weight="fill" className="dg-trophy" aria-hidden="true" />
        Seus prêmios <span className="mono dg-count">{rows.length}</span>
      </h2>
      <ul className="pz-list">{rows.map((p) => <PrizeCard key={p.id} prize={p} />)}</ul>
    </section>
  )
}
