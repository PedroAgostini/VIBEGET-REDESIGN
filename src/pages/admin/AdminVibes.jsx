import { useEffect, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { ArrowSquareOut, Gavel } from '@phosphor-icons/react'
import { api, brl } from '../../lib/api.js'
import { useApi } from '../../lib/useApi.js'
import { countdown } from '../../App.jsx'
import { CAT_LABEL } from '../../components/VibeCard.jsx'
import { LoadError, PageHead, Pager, Skeleton, dateFmt } from '../dashboard/ui.jsx'
import { ConfirmAction, FilterChips, ReadOnlyNote, useIsAdmin, useStatusFilter } from './ui.jsx'

const FILTERS = [['LIVE', 'Ao vivo'], ['SCHEDULED', 'Agendadas'], ['DRAFT', 'Rascunhos'], ['ENDED', 'Encerradas'], ['CANCELLED', 'Canceladas'], ['ALL', 'Todas']]
const STATUS = { LIVE: ['Ao vivo', 'lead'], SCHEDULED: ['Agendada', 'wait'], DRAFT: ['Rascunho', 'off'], ENDED: ['Encerrada', 'ok'], CANCELLED: ['Cancelada', 'off'] }

function useNow(ms = 1000) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(id)
  }, [ms])
  return now
}

function When({ v, now }) {
  if (v.status === 'LIVE') {
    const left = new Date(v.endsAt).getTime() - now
    return <><span className="ad-when-label">Termina em</span><span className="mono">{left > 0 ? countdown(left) : 'encerrando'}</span></>
  }
  if (v.status === 'SCHEDULED') return <><span className="ad-when-label">Abre em</span><span className="mono">{countdown(Math.max(0, new Date(v.startsAt).getTime() - now))}</span></>
  if (v.status === 'ENDED') return <><span className="ad-when-label">Encerrou em</span><span className="mono">{dateFmt.format(new Date(v.settledAt ?? v.endsAt))}</span></>
  return <><span className="ad-when-label">Termina</span><span className="mono">{dateFmt.format(new Date(v.endsAt))}</span></>
}

function VibeRow({ v, now, isAdmin, onChanged }) {
  const [label, tone] = STATUS[v.status] ?? [v.status, 'off']
  const open = v.status === 'LIVE' || v.status === 'SCHEDULED' || v.status === 'DRAFT'
  const close = async () => {
    await api(`/admin/vibes/${v.id}/close`, { method: 'POST' })
    onChanged()
  }
  const cancel = async () => {
    await api(`/admin/vibes/${v.id}`, { method: 'PATCH', body: { status: 'CANCELLED' } })
    onChanged()
  }

  return (
    <li className="ad-item glass">
      <div className="ad-vibe-row">
        <div className="ad-vibe-name">
          <p className="ad-who-name">{v.product.name}</p>
          <p className="ad-who-meta">{CAT_LABEL[v.product.category] ?? v.product.category} · Get mínimo <span className="mono">{brl(v.minGetCents)}</span> · cashback <span className="mono">{v.cashbackPercent}%</span></p>
        </div>
        <span className={`dg-pill dg-pill-${tone}`}>{label}</span>
        <p className="ad-when"><When v={v} now={now} /></p>
        <dl className="ad-vibe-figs">
          <div><dt>Gets</dt><dd className="mono">{v.confirmedGets}{v.goalGets ? `/${v.goalGets}` : ''}</dd></div>
          <div><dt>{v.status === 'ENDED' ? 'Champion Get' : 'Maior Get'}</dt><dd className="mono">{v.topGet ? brl(v.topGet.totalCents) : '—'}</dd></div>
          <div><dt>{v.status === 'ENDED' ? 'Vencedor' : 'De'}</dt><dd>{v.topGet?.by ?? '—'}</dd></div>
        </dl>
      </div>
      <div className="ad-item-actions">
        {v.status !== 'DRAFT' && v.status !== 'CANCELLED' && (
          <a className="btn btn-sm btn-glass" href={`/vibes/${v.slug}`} target="_blank" rel="noreferrer">Ver página<ArrowSquareOut size={15} aria-hidden="true" /></a>
        )}
        {isAdmin && open && (
          <ConfirmAction
            label="Cancelar" tone="danger" confirmLabel="Cancelar a Vibe"
            warning="Todos os Gets são estornados: o dinheiro volta (Pix e cartão pelo provedor, saldo na hora) e o GetCoin usado volta para a carteira. Não há cashback nem vencedor."
            onConfirm={cancel}
          />
        )}
        {isAdmin && v.status === 'LIVE' && (
          <ConfirmAction
            label="Encerrar agora" tone="coin" confirmLabel="Encerrar e definir vencedor"
            warning={`Encerra antes do prazo. O maior Get confirmado vence${v.topGet ? ` (${brl(v.topGet.totalCents)}, ${v.topGet.by})` : ''} e os outros recebem ${v.cashbackPercent}% de cashback. Não dá para desfazer.`}
            onConfirm={close}
          />
        )}
      </div>
    </li>
  )
}

export default function AdminVibes() {
  const isAdmin = useIsAdmin()
  const { dashboard } = useOutletContext()
  const [status, setStatus] = useStatusFilter(FILTERS, 'LIVE')
  const [page, setPage] = useState(1)
  const now = useNow()
  const query = status === 'ALL' ? '' : `&status=${status}`
  const list = useApi(`/admin/vibes?page=${page}&pageSize=20${query}`)
  const rows = list.data?.data ?? []
  const byStatus = dashboard.data?.data?.vibes.byStatus ?? {}
  const changed = () => { list.reload(); dashboard.reload() }

  return (
    <div className="dp">
      <PageHead title="Vibes" />
      <p className="dh-text ad-lede">O encerramento acontece sozinho no fim do prazo. Aqui você acompanha as disputas e, se precisar, encerra antes ou cancela.</p>
      {!isAdmin && <ReadOnlyNote />}
      <FilterChips label="Filtrar Vibes" options={FILTERS} value={status} onChange={(s) => { setStatus(s); setPage(1) }} counts={byStatus} />
      {list.error ? <LoadError message={list.error} onRetry={list.reload} />
        : list.loading && !list.data ? <Skeleton lines={5} />
          : rows.length === 0 ? (
            <div className="dg-onboarding glass">
              <Gavel size={32} weight="duotone" aria-hidden="true" />
              <div className="dg-onboarding-copy">
                <h2 className="dh-section-title">Nenhuma Vibe aqui</h2>
                <p className="dh-text">Nenhuma Vibe com essa situação.</p>
              </div>
            </div>
          ) : (
            <ul className="ad-list">{rows.map((v) => <VibeRow key={v.id} v={v} now={now} isAdmin={isAdmin} onChanged={changed} />)}</ul>
          )}
      <Pager meta={list.data?.meta} onPage={setPage} />
    </div>
  )
}
