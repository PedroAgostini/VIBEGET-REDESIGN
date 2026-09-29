import { useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { MapPin, Package, Truck } from '@phosphor-icons/react'
import { api, brl, fieldErrors } from '../../lib/api.js'
import { useApi } from '../../lib/useApi.js'
import { CopyButton } from '../dashboard/Home.jsx'
import { LoadError, PageHead, Pager, Skeleton, dateFmt, dayFmt } from '../dashboard/ui.jsx'
import { ConfirmAction, FilterChips, ReadOnlyNote, useIsAdmin, useStatusFilter } from './ui.jsx'

const FILTERS = [['PREPARING', 'Para enviar'], ['AWAITING_ADDRESS', 'Aguardando endereço'], ['SHIPPED', 'Enviados'], ['DELIVERED', 'Entregues'], ['ALL', 'Todas']]
const STATUS = {
  AWAITING_ADDRESS: ['Aguardando endereço', 'wait'],
  PREPARING: ['Para enviar', 'lead'],
  SHIPPED: ['Enviado', 'ok'],
  DELIVERED: ['Entregue', 'off'],
}
const CARRIERS = ['Correios', 'Jadlog', 'Loggi', 'Total Express']

const cepFmt = (c = '') => c.replace(/^(\d{5})(\d{3})$/, '$1-$2')
const phoneFmt = (p = '') => p.replace(/^(\d{2})(\d{4,5})(\d{4})$/, '($1) $2-$3')
const labelText = (d) => {
  const a = d.address
  return [
    d.recipientName,
    `${a.street}, ${a.number}${a.complement ? ` - ${a.complement}` : ''}`,
    `${a.district} - ${a.city}/${a.state}`,
    `CEP ${cepFmt(a.cep)}`,
    `Tel. ${phoneFmt(d.phone)}`,
  ].join('\n')
}

function ShipForm({ prize, onShipped, onCancel }) {
  const [carrier, setCarrier] = useState(prize.carrier ?? 'Correios')
  const [tracking, setTracking] = useState(prize.trackingCode ?? '')
  const [errors, setErrors] = useState({})
  const [alert, setAlert] = useState(null)
  const [busy, setBusy] = useState(false)

  async function submit(e) {
    e.preventDefault()
    const found = {}
    if (carrier.trim().length < 2) found.carrier = 'Informe a transportadora.'
    if (tracking.trim().length < 4) found.trackingCode = 'Informe o código de rastreio.'
    setErrors(found)
    if (Object.keys(found).length) return
    setBusy(true)
    setAlert(null)
    try {
      await api(`/admin/prizes/${prize.id}`, { method: 'PATCH', body: { status: 'SHIPPED', carrier: carrier.trim(), trackingCode: tracking.trim().toUpperCase() } })
      onShipped()
    } catch (err) {
      const byField = fieldErrors(err)
      if (Object.keys(byField).length) setErrors(byField)
      else setAlert(err.message)
      setBusy(false)
    }
  }

  return (
    <form className="ad-ship" onSubmit={submit} noValidate aria-label="Registrar envio">
      <div className="ad-ship-grid">
        <div className="af-field">
          <div className="af-label-row"><label htmlFor={`ad-carrier-${prize.id}`}>Transportadora</label></div>
          <input id={`ad-carrier-${prize.id}`} className="af-input" list="ad-carriers" value={carrier} onChange={(e) => setCarrier(e.target.value)} aria-invalid={errors.carrier ? 'true' : undefined} />
          <datalist id="ad-carriers">{CARRIERS.map((c) => <option key={c} value={c} />)}</datalist>
          {errors.carrier && <p className="af-error">{errors.carrier}</p>}
        </div>
        <div className="af-field">
          <div className="af-label-row"><label htmlFor={`ad-track-${prize.id}`}>Código de rastreio</label></div>
          <input id={`ad-track-${prize.id}`} className="af-input mono" autoComplete="off" spellCheck="false" value={tracking} onChange={(e) => setTracking(e.target.value)} placeholder="AA123456789BR" aria-invalid={errors.trackingCode ? 'true' : undefined} />
          {errors.trackingCode && <p className="af-error">{errors.trackingCode}</p>}
        </div>
      </div>
      {alert && <p className="af-error" role="alert">{alert}</p>}
      <div className="ad-confirm-actions">
        {onCancel && <button type="button" className="btn btn-sm btn-glass" onClick={onCancel} disabled={busy}>Voltar</button>}
        <button type="submit" className="btn btn-sm btn-coin" disabled={busy}>{busy ? 'Salvando…' : prize.status === 'SHIPPED' ? 'Salvar rastreio' : 'Marcar como enviado'}</button>
      </div>
    </form>
  )
}

function DeliveryCard({ d, isAdmin, onChanged }) {
  const [editingTracking, setEditingTracking] = useState(false)
  const [label, tone] = STATUS[d.status] ?? [d.status, 'off']
  const p = d.product

  const deliver = async () => {
    await api(`/admin/prizes/${d.id}`, { method: 'PATCH', body: { status: 'DELIVERED' } })
    onChanged()
  }

  return (
    <li className={`ad-item glass ${d.status === 'PREPARING' ? 'is-pending' : ''}`}>
      <div className="ad-prize-head">
        <div className="pz-plate ad-plate">{p.imageUrl ? <img src={p.imageUrl} alt="" loading="lazy" /> : <Package size={28} weight="duotone" aria-hidden="true" />}</div>
        <div className="ad-prize-info">
          <p className="ad-who-name">{p.name}</p>
          <p className="ad-who-meta">
            Vencedor: <b>{d.user?.name ?? '—'}</b> · {d.user?.email ?? ''} · Get vencedor <span className="mono">{brl(d.winningGetCents)}</span>
          </p>
          <p className="ad-who-meta">Vibe encerrada em <span className="mono">{d.vibe.settledAt ? dateFmt.format(new Date(d.vibe.settledAt)) : '—'}</span></p>
        </div>
        <span className={`dg-pill dg-pill-${tone}`}>{label}</span>
      </div>

      {d.address ? (
        <div className="pz-address ad-address">
          <MapPin size={18} aria-hidden="true" />
          <div>
            <p className="pz-address-who">{d.recipientName} · <span className="mono">{phoneFmt(d.phone)}</span></p>
            <p className="pz-address-line">{d.address.street}, {d.address.number}{d.address.complement ? ` · ${d.address.complement}` : ''}</p>
            <p className="pz-address-line">{d.address.district} · {d.address.city}/{d.address.state} · CEP {cepFmt(d.address.cep)}</p>
          </div>
          <CopyButton value={labelText(d)} label="Copiar endereço" />
        </div>
      ) : (
        <p className="ad-item-note">O vencedor ainda não confirmou o endereço. Ele vê um aviso no Início e em Meus Gets.</p>
      )}

      {d.status === 'SHIPPED' && !editingTracking && (
        <div className="pz-track">
          <Truck size={20} aria-hidden="true" />
          <div>
            <p className="pz-track-label">Enviado por {d.carrier} em {dayFmt.format(new Date(d.shippedAt))}</p>
            <p className="mono pz-track-code">{d.trackingCode}</p>
          </div>
          <CopyButton value={d.trackingCode} label="Copiar rastreio" />
        </div>
      )}
      {d.status === 'DELIVERED' && <p className="pz-note is-done">Entregue em {dayFmt.format(new Date(d.deliveredAt))} · {d.carrier} <span className="mono">{d.trackingCode}</span></p>}

      {isAdmin && d.status === 'PREPARING' && <ShipForm prize={d} onShipped={onChanged} />}
      {isAdmin && d.status === 'SHIPPED' && (
        editingTracking ? (
          <ShipForm prize={d} onShipped={() => { setEditingTracking(false); onChanged() }} onCancel={() => setEditingTracking(false)} />
        ) : (
          <div className="ad-item-actions">
            <button type="button" className="btn btn-sm btn-glass" onClick={() => setEditingTracking(true)}>Corrigir rastreio</button>
            <ConfirmAction label="Marcar como entregue" tone="coin" confirmLabel="Confirmar entrega" warning="Confirme só quando o rastreio mostrar a entrega ao vencedor." onConfirm={deliver} />
          </div>
        )
      )}
    </li>
  )
}

export default function Deliveries() {
  const isAdmin = useIsAdmin()
  const { dashboard } = useOutletContext()
  const [status, setStatus] = useStatusFilter(FILTERS, 'PREPARING')
  const [page, setPage] = useState(1)
  const query = status === 'ALL' ? '' : `&status=${status}`
  const list = useApi(`/admin/prizes?page=${page}&pageSize=20${query}`)
  const rows = list.data?.data ?? []
  const pending = dashboard.data?.data?.pending
  const changed = () => { list.reload(); dashboard.reload() }

  return (
    <div className="dp">
      <PageHead title="Entregas de prêmio" />
      <p className="dh-text ad-lede">Quando uma Vibe encerra, o vencedor confirma o endereço. Você envia o produto, registra o rastreio e marca a entrega. O vencedor acompanha tudo em Meus Gets.</p>
      {!isAdmin && <ReadOnlyNote />}
      <FilterChips
        label="Filtrar entregas" options={FILTERS} value={status} onChange={(s) => { setStatus(s); setPage(1) }}
        counts={{ PREPARING: pending?.prizesToShip, AWAITING_ADDRESS: pending?.prizesAwaitingAddress }}
      />
      {list.error ? <LoadError message={list.error} onRetry={list.reload} />
        : list.loading && !list.data ? <Skeleton lines={5} />
          : rows.length === 0 ? (
            <div className="dg-onboarding glass">
              <Package size={32} weight="duotone" aria-hidden="true" />
              <div className="dg-onboarding-copy">
                <h2 className="dh-section-title">{status === 'PREPARING' ? 'Nada para enviar agora' : 'Nada por aqui'}</h2>
                <p className="dh-text">{status === 'PREPARING' ? 'Quando um vencedor confirmar o endereço, o prêmio aparece aqui para envio.' : 'Nenhuma entrega com essa situação.'}</p>
              </div>
            </div>
          ) : (
            <ul className="ad-list">{rows.map((d) => <DeliveryCard key={d.id} d={d} isAdmin={isAdmin} onChanged={changed} />)}</ul>
          )}
      <Pager meta={list.data?.meta} onPage={setPage} />
    </div>
  )
}
