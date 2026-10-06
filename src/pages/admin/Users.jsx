import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { CaretDown, CaretRight, MagnifyingGlass, Users as UsersIcon } from '@phosphor-icons/react'
import { useApi } from '../../lib/useApi.js'
import { LoadError, PageHead, Pager, Skeleton, dayFmt } from '../dashboard/ui.jsx'
import { FilterChips } from './ui.jsx'

export const ROLE = { USER: ['Usuário', 'off'], SUPPORT: ['Suporte', 'wait'], ADMIN: ['Admin', 'ok'] }
export const STATUS = { ACTIVE: ['Ativa', 'ok'], SUSPENDED: ['Suspensa', 'ember'], DELETED: ['Excluída', 'off'] }
export const LEVEL = { EXPLORADOR: 'Explorador', VIBER: 'Viber' }
export const initials = (name = '') => name.trim().split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?'

const ROLES = [['ALL', 'Todos'], ['USER', 'Usuários'], ['SUPPORT', 'Suporte'], ['ADMIN', 'Admins']]
const STATUSES = [['ALL', 'Qualquer situação'], ['ACTIVE', 'Ativas'], ['SUSPENDED', 'Suspensas'], ['DELETED', 'Excluídas']]
const pick = (options, value) => (options.some(([id]) => id === value) ? value : 'ALL')

export default function Users() {
  const [params, setParams] = useSearchParams()
  const role = pick(ROLES, params.get('papel'))
  const status = pick(STATUSES, params.get('situacao'))
  const q = params.get('q') ?? ''
  const [text, setText] = useState(q)
  const [page, setPage] = useState(1)

  const setParam = (key, value) => {
    const next = new URLSearchParams(params)
    if (!value || value === 'ALL') next.delete(key)
    else next.set(key, value)
    setParams(next, { replace: true })
    setPage(1)
  }

  // Busca só depois de uma pausa na digitação.
  useEffect(() => {
    const id = setTimeout(() => { if (text.trim() !== q) setParam('q', text.trim()) }, 350)
    return () => clearTimeout(id)
  }, [text]) // eslint-disable-line react-hooks/exhaustive-deps

  const query = new URLSearchParams({ page: String(page), pageSize: '20' })
  if (q) query.set('q', q)
  if (role !== 'ALL') query.set('role', role)
  if (status !== 'ALL') query.set('status', status)
  const list = useApi(`/admin/users?${query}`)
  const rows = list.data?.data ?? []
  const total = list.data?.meta.total ?? 0

  return (
    <div className="dp">
      <PageHead title="Usuários" />
      <div className="ad-toolbar">
        <label className="ad-search">
          <MagnifyingGlass size={18} aria-hidden="true" />
          <span className="sr-only">Buscar usuário</span>
          <input type="search" placeholder="Nome, e-mail ou CPF" value={text} onChange={(e) => setText(e.target.value)} />
        </label>
        <label className="vp-sort">
          <span className="sr-only">Situação da conta</span>
          <select value={status} onChange={(e) => setParam('situacao', e.target.value)}>
            {STATUSES.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
          </select>
          <CaretDown size={16} aria-hidden="true" />
        </label>
      </div>
      <FilterChips label="Filtrar por papel" options={ROLES} value={role} onChange={(r) => setParam('papel', r)} />

      {list.error ? <LoadError message={list.error} onRetry={list.reload} />
        : list.loading && !list.data ? <Skeleton lines={6} />
          : rows.length === 0 ? (
            <div className="dg-onboarding glass">
              <UsersIcon size={32} weight="duotone" aria-hidden="true" />
              <div className="dg-onboarding-copy">
                <h2 className="dh-section-title">Ninguém encontrado</h2>
                <p className="dh-text">Confira a busca ou os filtros.</p>
              </div>
            </div>
          ) : (
            <>
              <p className="ad-count"><span className="mono">{total}</span> {total === 1 ? 'conta' : 'contas'}</p>
              <ul className="ad-users glass">
                {rows.map((u) => {
                  const [roleLabel, roleTone] = ROLE[u.role] ?? [u.role, 'off']
                  const [stLabel, stTone] = STATUS[u.status] ?? [u.status, 'off']
                  return (
                    <li key={u.id}>
                      <Link to={`/admin/usuarios/${u.id}`} className="ad-user-row">
                        <span className="mk-avatar" aria-hidden="true">{initials(u.name)}</span>
                        <span className="ad-user-main">
                          <span className="ad-who-name">{u.name}</span>
                          <span className="ad-who-meta">{u.email}{u.emailVerified ? '' : ' · e-mail não confirmado'}</span>
                        </span>
                        <span className="ad-user-tags">
                          <span className="ad-level">{LEVEL[u.level] ?? u.level}</span>
                          {u.role !== 'USER' && <span className={`dg-pill dg-pill-${roleTone}`}>{roleLabel}</span>}
                          {u.status !== 'ACTIVE' && <span className={`dg-pill dg-pill-${stTone}`}>{stLabel}</span>}
                        </span>
                        <span className="ad-user-date mono" title="Cadastro">{dayFmt.format(new Date(u.createdAt))}</span>
                        <CaretRight size={16} className="ad-user-go" aria-hidden="true" />
                      </Link>
                    </li>
                  )
                })}
              </ul>
            </>
          )}
      <Pager meta={list.data?.meta} onPage={setPage} />
    </div>
  )
}
