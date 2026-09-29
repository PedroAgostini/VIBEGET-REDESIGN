import { useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { Money } from '@phosphor-icons/react'
import { api, brl } from '../../lib/api.js'
import { useApi } from '../../lib/useApi.js'
import { CopyButton } from '../dashboard/Home.jsx'
import { LoadError, PageHead, Pager, Skeleton, dateFmt } from '../dashboard/ui.jsx'
import { ConfirmAction, FilterChips, ReadOnlyNote, useIsAdmin, useStatusFilter } from './ui.jsx'

const FILTERS = [['PENDING', 'Pendentes'], ['PAID', 'Pagos'], ['REJECTED', 'Recusados'], ['ALL', 'Todos']]
const STATUS = { PENDING: ['Pendente', 'wait'], PAID: ['Pago', 'ok'], REJECTED: ['Recusado', 'off'] }
const KEY_LABEL = { CPF: 'CPF', EMAIL: 'E-mail', PHONE: 'Celular', RANDOM: 'Chave aleatória' }
const initials = (name = '') => name.trim().split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?'
/** Só para leitura; a cópia usa a chave como a API guarda. */
const keyFmt = (type, key) => (type === 'CPF' ? key.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4') : key)

function RejectForm({ onReject, onCancel }) {
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  async function submit(e) {
    e.preventDefault()
    if (reason.trim().length < 5) return setError('Explique o motivo em pelo menos 5 caracteres. O usuário vê esse texto.')
    setBusy(true)
    setError(null)
    try {
      await onReject(reason.trim())
    } catch (err) {
      setError(err.message)
      setBusy(false)
    }
  }
  return (
    <form className="ad-reject" onSubmit={submit} noValidate>
      <label className="sr-only" htmlFor="ad-reject-reason">Motivo da recusa</label>
      <input
        id="ad-reject-reason" className="af-input" maxLength={500} placeholder="Motivo (o usuário vê este texto)" autoFocus
        value={reason} onChange={(e) => setReason(e.target.value)} aria-invalid={error ? 'true' : undefined}
      />
      {error && <p className="af-error" role="alert">{error}</p>}
      <div className="ad-confirm-actions">
        <button type="button" className="btn btn-sm btn-glass" onClick={onCancel} disabled={busy}>Voltar</button>
        <button type="submit" className="btn btn-sm btn-glass btn-danger" disabled={busy}>{busy ? 'Recusando…' : 'Recusar e devolver ao saldo'}</button>
      </div>
    </form>
  )
}

function WithdrawalRow({ w, isAdmin, onChanged }) {
  const [rejecting, setRejecting] = useState(false)
  const [label, tone] = STATUS[w.status] ?? [w.status, 'off']
  const pending = w.status === 'PENDING'

  const approve = async () => {
    await api(`/admin/withdrawals/${w.id}/approve`, { method: 'POST', body: {} })
    onChanged()
  }
  const reject = async (reason) => {
    await api(`/admin/withdrawals/${w.id}/reject`, { method: 'POST', body: { reason } })
    onChanged()
  }

  return (
    <li className={`ad-item glass ${pending ? 'is-pending' : ''}`}>
      <div className="ad-item-main">
        <div className="ad-item-amount">
          <p className="mono ad-money">{brl(w.amountCents)}</p>
          <span className={`dg-pill dg-pill-${tone}`}>{label}</span>
        </div>
        <div className="ad-item-who ad-person">
          <span className="mk-avatar" aria-hidden="true">{initials(w.userName)}</span>
          <div>
            <p className="ad-who-name">{w.userName}</p>
            <p className="ad-who-meta">{w.userEmail} · pedido em <span className="mono">{dateFmt.format(new Date(w.createdAt))}</span></p>
          </div>
        </div>
        <div className="ad-item-key">
          <p className="ad-key-type">Pix · {KEY_LABEL[w.pixKeyType] ?? w.pixKeyType}</p>
          <p className="mono ad-key">{w.pixKey ? keyFmt(w.pixKeyType, w.pixKey) : w.pixKeyMasked}</p>
          {isAdmin && pending && w.pixKey && <CopyButton value={w.pixKey} label="Copiar chave" />}
        </div>
      </div>

      {w.status === 'REJECTED' && w.rejectReason && <p className="ad-item-note">Motivo: {w.rejectReason}</p>}
      {w.decidedAt && <p className="ad-item-note">Decidido em <span className="mono">{dateFmt.format(new Date(w.decidedAt))}</span></p>}

      {isAdmin && pending && (
        <div className="ad-item-actions">
          {rejecting ? (
            <RejectForm onReject={reject} onCancel={() => setRejecting(false)} />
          ) : (
            <>
              <button type="button" className="btn btn-sm btn-glass btn-danger" onClick={() => setRejecting(true)}>Recusar</button>
              <ConfirmAction
                label="Marcar como pago" tone="coin" confirmLabel={`Confirmar Pix de ${brl(w.amountCents)}`}
                warning="Faça o Pix no banco antes. Esta ação só registra o pagamento; ela não envia dinheiro."
                onConfirm={approve}
              />
            </>
          )}
        </div>
      )}
    </li>
  )
}

export default function Withdrawals() {
  const isAdmin = useIsAdmin()
  const { dashboard } = useOutletContext()
  const [status, setStatus] = useStatusFilter(FILTERS, 'PENDING')
  const [page, setPage] = useState(1)
  const query = status === 'ALL' ? '' : `&status=${status}`
  const list = useApi(`/admin/withdrawals?page=${page}&pageSize=20${query}`)
  const rows = list.data?.data ?? []
  const pendingCount = dashboard.data?.data?.pending?.withdrawals.count
  const changed = () => { list.reload(); dashboard.reload() }

  return (
    <div className="dp">
      <PageHead title="Saques" />
      {!isAdmin && <ReadOnlyNote />}
      <FilterChips label="Filtrar saques" options={FILTERS} value={status} onChange={(s) => { setStatus(s); setPage(1) }} counts={{ PENDING: pendingCount }} />
      {list.error ? <LoadError message={list.error} onRetry={list.reload} />
        : list.loading && !list.data ? <Skeleton lines={5} />
          : rows.length === 0 ? (
            <div className="dg-onboarding glass">
              <Money size={32} weight="duotone" aria-hidden="true" />
              <div className="dg-onboarding-copy">
                <h2 className="dh-section-title">{status === 'PENDING' ? 'Nenhum saque esperando' : 'Nada por aqui'}</h2>
                <p className="dh-text">{status === 'PENDING' ? 'Quando um usuário pedir um saque, ele aparece aqui para você pagar.' : 'Nenhum saque com essa situação.'}</p>
              </div>
            </div>
          ) : (
            <ul className="ad-list">{rows.map((w) => <WithdrawalRow key={w.id} w={w} isAdmin={isAdmin} onChanged={changed} />)}</ul>
          )}
      <Pager meta={list.data?.meta} onPage={setPage} />
    </div>
  )
}
