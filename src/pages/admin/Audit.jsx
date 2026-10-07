import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { ArrowSquareOut, CaretDown, ClockCounterClockwise, Robot, X } from '@phosphor-icons/react'
import { useApi } from '../../lib/useApi.js'
import { LoadError, PageHead, Pager, Skeleton } from '../dashboard/ui.jsx'
import { ACTIONS, AREAS, actionLabel, entityLink } from './auditLabels.js'
import { describe } from './UserDetail.jsx'

const timeFmt = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
const dayTitle = new Intl.DateTimeFormat('pt-BR', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' })
const dayKey = (d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`

/** Valor do metadata em texto curto (objetos viram JSON compacto). */
const show = (v) => (v == null ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v))

function Details({ log }) {
  const entries = Object.entries(log.metadata ?? {})
  if (!entries.length && !log.ip && !log.entityId) return null
  return (
    <details className="au-details">
      <summary>Detalhes</summary>
      <dl>
        {log.entityId && <div><dt>Registro</dt><dd className="mono">{AREAS[log.entity] ?? log.entity} · {log.entityId}</dd></div>}
        {entries.map(([k, v]) => <div key={k}><dt>{k}</dt><dd className="mono">{show(v)}</dd></div>)}
        {log.ip && <div><dt>IP</dt><dd className="mono">{log.ip}</dd></div>}
      </dl>
    </details>
  )
}

export default function Audit() {
  const [params, setParams] = useSearchParams()
  const area = AREAS[params.get('area')] ? params.get('area') : ''
  const action = ACTIONS[params.get('acao')] ? params.get('acao') : ''
  const from = params.get('de') ?? ''
  const to = params.get('ate') ?? ''
  const actorId = params.get('pessoa') ?? ''
  const actorName = params.get('nome') ?? ''
  const [page, setPage] = useState(1)

  const update = (changes) => {
    const next = new URLSearchParams(params)
    for (const [k, v] of Object.entries(changes)) {
      if (v) next.set(k, v)
      else next.delete(k)
    }
    setParams(next, { replace: true })
    setPage(1)
  }

  const query = new URLSearchParams({ page: String(page), pageSize: '30' })
  if (area) query.set('entity', area)
  if (action) query.set('action', action)
  if (actorId) query.set('actorId', actorId)
  // Datas do filtro são dias inteiros no fuso de quem está olhando.
  if (from) query.set('from', new Date(`${from}T00:00:00`).toISOString())
  if (to) query.set('to', new Date(`${to}T23:59:59.999`).toISOString())
  const list = useApi(`/admin/audit-logs?${query}`)
  const rows = list.data?.data ?? []
  const filtered = Boolean(area || action || from || to || actorId)
  // Ações do seletor: só as da área escolhida (ou todas), em ordem alfabética.
  const actionOptions = Object.entries(ACTIONS)
    .filter(([, [, a]]) => !area || a === area)
    .sort((x, y) => x[1][0].localeCompare(y[1][0], 'pt-BR'))

  let lastDay = null
  return (
    <div className="dp">
      <PageHead title="Auditoria" />
      <div className="au-filters glass">
        <label className="au-field">
          <span>Área</span>
          <span className="vp-sort">
            <select value={area} onChange={(e) => update({ area: e.target.value, acao: '' })}>
              <option value="">Todas</option>
              {Object.entries(AREAS).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
            </select>
            <CaretDown size={16} aria-hidden="true" />
          </span>
        </label>
        <label className="au-field">
          <span>Ação</span>
          <span className="vp-sort">
            <select value={action} onChange={(e) => update({ acao: e.target.value })}>
              <option value="">Todas</option>
              {actionOptions.map(([code, [label]]) => <option key={code} value={code}>{label}</option>)}
            </select>
            <CaretDown size={16} aria-hidden="true" />
          </span>
        </label>
        <label className="au-field">
          <span>De</span>
          <input type="date" className="af-input" value={from} max={to || undefined} onChange={(e) => update({ de: e.target.value })} />
        </label>
        <label className="au-field">
          <span>Até</span>
          <input type="date" className="af-input" value={to} min={from || undefined} onChange={(e) => update({ ate: e.target.value })} />
        </label>
        {filtered && (
          <button type="button" className="btn btn-sm btn-glass au-clear" onClick={() => { setParams({}, { replace: true }); setPage(1) }}>
            <X size={14} weight="bold" aria-hidden="true" />Limpar filtros
          </button>
        )}
      </div>
      {actorId && (
        <p className="mm-scope">
          <span>Só as ações de <b>{actorName || 'uma pessoa'}</b>.</span>
          <Link to={`/admin/usuarios/${actorId}`} className="mm-scope-clear">Abrir conta</Link>
          <button type="button" className="mm-scope-clear" onClick={() => update({ pessoa: '', nome: '' })}><X size={14} weight="bold" aria-hidden="true" />Ver de todos</button>
        </p>
      )}

      {list.error ? <LoadError message={list.error} onRetry={list.reload} />
        : list.loading && !list.data ? <Skeleton lines={8} />
          : rows.length === 0 ? (
            <div className="dg-onboarding glass">
              <ClockCounterClockwise size={32} weight="duotone" aria-hidden="true" />
              <div className="dg-onboarding-copy">
                <h2 className="dh-section-title">Nada registrado</h2>
                <p className="dh-text">{filtered ? 'Nenhum registro com esses filtros.' : 'Ainda não há registros.'}</p>
              </div>
            </div>
          ) : (
            <>
              <p className="ad-count"><span className="mono">{list.data.meta.total}</span> {list.data.meta.total === 1 ? 'registro' : 'registros'}</p>
              <ol className="au-list glass">
                {rows.map((l) => {
                  const at = new Date(l.createdAt)
                  const header = dayKey(at) !== lastDay ? dayTitle.format(at) : null
                  lastDay = dayKey(at)
                  const [what, why] = describe(l)
                  const link = entityLink(l.entity, l.entityId)
                  return (
                    <li key={l.id} className="au-row-wrap">
                      {header && <p className="au-day">{header}</p>}
                      <div className="au-row">
                        <span className="au-time mono">{timeFmt.format(at)}</span>
                        <div className="au-main">
                          <p className="ad-log-title">
                            {actionLabel(l.action)}
                            {what && <> · <span className="mono">{what}</span></>}
                          </p>
                          {why && <p className="ad-log-why">“{why}”</p>}
                          <p className="ad-who-meta au-meta">
                            {l.actorId ? (
                              <button type="button" className="au-actor" onClick={() => update({ pessoa: l.actorId, nome: l.actorName ?? '' })} title="Ver só as ações desta pessoa">
                                {l.actorName ?? 'Conta removida'}
                              </button>
                            ) : (
                              <span className="au-system"><Robot size={14} aria-hidden="true" />Sistema</span>
                            )}
                            <span className="au-area">{AREAS[l.entity] ?? l.entity}</span>
                            {link && <Link to={link} className="au-open">Abrir<ArrowSquareOut size={12} aria-hidden="true" /></Link>}
                          </p>
                          <Details log={l} />
                        </div>
                      </div>
                    </li>
                  )
                })}
              </ol>
            </>
          )}
      <Pager meta={list.data?.meta} onPage={setPage} />
    </div>
  )
}
