import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { ArrowsClockwise, CircleNotch, MagnifyingGlass, Plus, Ticket, UsersThree } from '@phosphor-icons/react'
import { api, coins, fieldErrors } from '../../lib/api.js'
import { useApi } from '../../lib/useApi.js'
import { Field } from '../../components/form.jsx'
import { CopyButton } from '../dashboard/Home.jsx'
import { LoadError, PageHead, Pager, Skeleton, dateFmt, dayFmt } from '../dashboard/ui.jsx'
import { FilterChips, ReadOnlyNote, useIsAdmin } from './ui.jsx'

const FILTERS = [['ALL', 'Todos'], ['true', 'Ligados'], ['false', 'Pausados']]
const MAX_COUPON_CENTS = 100_000

const digits = (v) => String(v).replace(/\D/g, '')
const centsText = (c) => (c / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 })
const maskCents = (t) => (digits(t) ? centsText(parseInt(digits(t), 10)) : '')
const pad = (n) => String(n).padStart(2, '0')
const toLocal = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
const randomCode = () => {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const bytes = crypto.getRandomValues(new Uint8Array(8))
  return `VIBE-${[...bytes].map((b) => abc[b % abc.length]).join('')}`
}

/** Situação real do cupom (ligado não basta: pode estar fora do prazo ou esgotado). */
function couponState(c, now = Date.now()) {
  if (!c.active) return ['Pausado', 'off']
  if (new Date(c.startsAt).getTime() > now) return ['Agendado', 'wait']
  if (c.endsAt && new Date(c.endsAt).getTime() <= now) return ['Encerrado', 'off']
  if (c.maxRedemptions != null && c.redemptionsCount >= c.maxRedemptions) return ['Esgotado', 'off']
  return ['Valendo', 'ok']
}

/** Cria (sem `coupon`) ou edita um cupom. Na edição, só manda o que mudou. */
function CouponForm({ coupon, onDone, onCancel }) {
  const editing = Boolean(coupon)
  const locked = editing && coupon.redemptionsCount > 0
  const initial = {
    amount: coupon ? centsText(coupon.amountCents) : '',
    maxR: coupon?.maxRedemptions != null ? String(coupon.maxRedemptions) : '',
    perUser: String(coupon?.perUserLimit ?? 1),
    startsAt: coupon ? toLocal(new Date(coupon.startsAt)) : '',
    endsAt: coupon?.endsAt ? toLocal(new Date(coupon.endsAt)) : '',
    newOnly: coupon?.newAccountsOnly ?? false,
    active: coupon?.active ?? true,
    description: coupon?.description ?? '',
  }
  const [code, setCode] = useState('')
  const [v, setV] = useState(initial)
  const [errors, setErrors] = useState({})
  const [alert, setAlert] = useState(null)
  const [busy, setBusy] = useState(false)
  const set = (key) => (value) => { setV((s) => ({ ...s, [key]: value })); setErrors((e) => ({ ...e, [key]: undefined })) }

  const amountCents = digits(v.amount) ? parseInt(digits(v.amount), 10) : 0

  function validate() {
    const e = {}
    if (!editing && !/^[A-Z0-9_-]{3,40}$/.test(code)) e.code = 'De 3 a 40 caracteres: letras, números, _ e -.'
    if (!amountCents) e.amountCents = 'Informe quantos GetCoins o cupom dá.'
    else if (amountCents > MAX_COUPON_CENTS) e.amountCents = `O máximo por resgate é ${coins(MAX_COUPON_CENTS)} GetCoins.`
    const per = parseInt(v.perUser, 10)
    if (!per || per > 100) e.perUserLimit = 'De 1 a 100 vezes.'
    if (v.maxR) {
      const m = parseInt(v.maxR, 10)
      if (!m) e.maxRedemptions = 'Use um número maior que zero, ou deixe vazio para não limitar.'
      else if (editing && m < coupon.redemptionsCount) e.maxRedemptions = `Já houve ${coupon.redemptionsCount} resgates: o limite não pode ser menor.`
    }
    const start = v.startsAt ? new Date(v.startsAt) : new Date()
    if (v.endsAt && new Date(v.endsAt) <= start) e.endsAt = 'O fim precisa ser depois do início.'
    return e
  }

  /** Corpo do POST/PATCH; na edição, compara com os valores iniciais do formulário. */
  function buildBody() {
    const changed = (key) => !editing || v[key] !== initial[key]
    const body = {}
    if (!editing) body.code = code
    if (changed('amount')) body.amountCents = amountCents
    if (changed('maxR')) body.maxRedemptions = v.maxR ? parseInt(v.maxR, 10) : null
    if (changed('perUser')) body.perUserLimit = parseInt(v.perUser, 10)
    if (v.startsAt && changed('startsAt')) body.startsAt = new Date(v.startsAt).toISOString()
    if (changed('endsAt')) body.endsAt = v.endsAt ? new Date(v.endsAt).toISOString() : null
    if (changed('newOnly')) body.newAccountsOnly = v.newOnly
    if (changed('active')) body.active = v.active
    if (changed('description') && (editing || v.description.trim())) body.description = v.description.trim() || null
    return body
  }

  async function submit(ev) {
    ev.preventDefault()
    const found = validate()
    setErrors(found)
    if (Object.keys(found).length) return
    const body = buildBody()
    if (editing && !Object.keys(body).length) { onCancel(); return }
    setBusy(true)
    setAlert(null)
    try {
      await api(editing ? `/admin/coupons/${coupon.id}` : '/admin/coupons', { method: editing ? 'PATCH' : 'POST', body })
      onDone()
    } catch (err) {
      const byField = fieldErrors(err)
      if (err.code === 'CODE_TAKEN') setErrors({ code: 'Já existe um cupom com esse código.' })
      else if (Object.keys(byField).length) setErrors(byField)
      else setAlert(err.message)
      setBusy(false)
    }
  }

  return (
    <form className={editing ? 'cp-form' : 'ad-panel glass cp-form'} onSubmit={submit} noValidate aria-label={editing ? `Editar ${coupon.code}` : 'Novo cupom'}>
      {!editing && <h2 className="dh-section-title">Novo cupom</h2>}
      <div className="cp-grid">
        {!editing && (
          <Field
            label="Código" value={code} maxLength={40} className="af-input mono" autoComplete="off" spellCheck="false"
            onChange={(e) => { setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9_-]/g, '')); setErrors((x) => ({ ...x, code: undefined })) }}
            error={errors.code} hint="É o que a pessoa digita na Carteira."
            aside={<button type="button" className="cp-gen" onClick={() => setCode(randomCode())}><ArrowsClockwise size={14} aria-hidden="true" /> Gerar</button>}
          />
        )}
        <Field
          label="GetCoins por resgate" inputMode="numeric" placeholder="0,00" className="af-input mono"
          value={v.amount} onChange={(e) => set('amount')(maskCents(e.target.value))} disabled={locked}
          error={errors.amountCents} hint={locked ? 'Não muda depois do primeiro resgate.' : undefined}
        />
        <Field label="Limite total de resgates" inputMode="numeric" placeholder="Sem limite" className="af-input mono" value={v.maxR} onChange={(e) => set('maxR')(digits(e.target.value).slice(0, 8))} error={errors.maxRedemptions} hint="Vazio: sem limite." />
        <Field label="Vezes por pessoa" inputMode="numeric" className="af-input mono" value={v.perUser} onChange={(e) => set('perUser')(digits(e.target.value).slice(0, 3))} error={errors.perUserLimit} />
        <Field label="Começa em" type="datetime-local" value={v.startsAt} onChange={(e) => set('startsAt')(e.target.value)} error={errors.startsAt} hint={editing ? undefined : 'Vazio: vale a partir de agora.'} />
        <Field label="Termina em" type="datetime-local" value={v.endsAt} onChange={(e) => set('endsAt')(e.target.value)} error={errors.endsAt} hint="Vazio: sem prazo." />
        <Field label="Descrição interna" value={v.description} maxLength={200} onChange={(e) => set('description')(e.target.value)} error={errors.description} placeholder="Ex.: campanha de lançamento no Instagram" />
      </div>
      <div className="cp-toggles">
        <label className="toggle">
          <input type="checkbox" checked={v.newOnly} disabled={locked} onChange={(e) => set('newOnly')(e.target.checked)} />
          <span className="switch" aria-hidden="true" />
          <span><b>Só contas novas</b><span className="st-hint">{locked ? 'Não muda depois do primeiro resgate.' : 'Só quem criou a conta depois do cupom consegue resgatar.'}</span></span>
        </label>
        <label className="toggle">
          <input type="checkbox" checked={v.active} onChange={(e) => set('active')(e.target.checked)} />
          <span className="switch" aria-hidden="true" />
          <span><b>Ligado</b><span className="st-hint">Pausado, ninguém resgata, mesmo dentro do prazo.</span></span>
        </label>
      </div>
      {alert && <p className="af-error" role="alert">{alert}</p>}
      <div className="ad-confirm-actions">
        <button type="button" className="btn btn-sm btn-glass" onClick={onCancel} disabled={busy}>Cancelar</button>
        <button type="submit" className="btn btn-sm btn-coin" disabled={busy} aria-busy={busy}>
          {busy && <CircleNotch size={16} className="af-spin" aria-hidden="true" />}
          {editing ? 'Salvar cupom' : 'Criar cupom'}
        </button>
      </div>
    </form>
  )
}

function Redemptions({ coupon }) {
  const [page, setPage] = useState(1)
  const list = useApi(`/admin/coupons/${coupon.id}/redemptions?page=${page}&pageSize=10`)
  const rows = list.data?.data ?? []
  if (list.error) return <LoadError message={list.error} onRetry={list.reload} />
  if (!list.data) return <Skeleton lines={2} />
  if (!rows.length) return <p className="ad-item-note">Ninguém resgatou ainda.</p>
  return (
    <div className="cp-redemptions">
      <ul>
        {rows.map((r) => (
          <li key={r.id}>
            <span className="ad-user-main">
              <span className="ad-who-name">{r.userName}</span>
              <span className="ad-who-meta">{r.userEmail}</span>
            </span>
            <span className="mono cp-red-amount">+{coins(r.amountCents)}</span>
            <span className="mono ad-who-meta">{dateFmt.format(new Date(r.createdAt))}</span>
          </li>
        ))}
      </ul>
      <Pager meta={list.data.meta} onPage={setPage} />
    </div>
  )
}

function CouponCard({ c, isAdmin, onChanged }) {
  const [editing, setEditing] = useState(false)
  const [showRedemptions, setShowRedemptions] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [label, tone] = couponState(c)
  const pct = c.maxRedemptions ? Math.min(100, Math.round((c.redemptionsCount / c.maxRedemptions) * 100)) : null

  async function toggleActive() {
    setBusy(true)
    setError(null)
    try {
      await api(`/admin/coupons/${c.id}`, { method: 'PATCH', body: { active: !c.active } })
      onChanged()
    } catch (err) {
      setError(err.message)
      setBusy(false)
    }
  }

  return (
    <li className={`ad-item glass cp-card ${c.active ? '' : 'is-paused'}`}>
      <div className="cp-head">
        <div className="cp-code-wrap">
          <span className="mono cp-code">{c.code}</span>
          <CopyButton value={c.code} label="Copiar código" />
        </div>
        <span className={`dg-pill dg-pill-${tone}`}>{label}</span>
      </div>
      <dl className="cp-figs">
        <div><dt>Dá</dt><dd className="mono cp-amount">+{coins(c.amountCents)} <span>GetCoins</span></dd></div>
        <div>
          <dt>Resgates</dt>
          <dd><span className="mono">{c.redemptionsCount}</span>{c.maxRedemptions ? <> de <span className="mono">{c.maxRedemptions}</span></> : ' · sem limite'}</dd>
          {pct != null && <div className="cp-bar" aria-hidden="true"><span style={{ width: `${pct}%` }} /></div>}
        </div>
        <div><dt>Por pessoa</dt><dd><span className="mono">{c.perUserLimit}</span> {c.perUserLimit === 1 ? 'vez' : 'vezes'}</dd></div>
        <div>
          <dt>Prazo</dt>
          <dd><span className="mono">{dayFmt.format(new Date(c.startsAt))}</span>{c.endsAt ? <> até <span className="mono">{dayFmt.format(new Date(c.endsAt))}</span></> : ' · sem fim'}</dd>
        </div>
      </dl>
      {(c.description || c.newAccountsOnly) && (
        <p className="ad-item-note cp-note">{c.newAccountsOnly && <b className="cp-tag">Só contas novas</b>}{c.description}</p>
      )}

      {editing ? (
        <CouponForm coupon={c} onDone={() => { setEditing(false); onChanged() }} onCancel={() => setEditing(false)} />
      ) : (
        <div className="ad-item-actions">
          {error && <p className="af-error" role="alert">{error}</p>}
          <button type="button" className="btn btn-sm btn-glass" aria-expanded={showRedemptions} onClick={() => setShowRedemptions((s) => !s)} disabled={!c.redemptionsCount}>
            <UsersThree size={16} aria-hidden="true" /> {showRedemptions ? 'Esconder resgates' : 'Ver resgates'}
          </button>
          {isAdmin && <button type="button" className="btn btn-sm btn-glass" onClick={() => setEditing(true)}>Editar</button>}
          {isAdmin && (
            <button type="button" className={`btn btn-sm ${c.active ? 'btn-glass' : 'btn-coin'}`} onClick={toggleActive} disabled={busy} aria-busy={busy}>
              {busy && <CircleNotch size={16} className="af-spin" aria-hidden="true" />}
              {c.active ? 'Pausar' : 'Ligar'}
            </button>
          )}
        </div>
      )}
      {showRedemptions && !editing && <Redemptions coupon={c} />}
    </li>
  )
}

export default function Coupons() {
  const isAdmin = useIsAdmin()
  const [params, setParams] = useSearchParams()
  const filter = FILTERS.some(([id]) => id === params.get('situacao')) ? params.get('situacao') : 'ALL'
  const q = params.get('q') ?? ''
  const [text, setText] = useState(q)
  const [page, setPage] = useState(1)
  const [creating, setCreating] = useState(false)

  const setParam = (key, value) => {
    const next = new URLSearchParams(params)
    if (!value || value === 'ALL') next.delete(key)
    else next.set(key, value)
    setParams(next, { replace: true })
    setPage(1)
  }
  useEffect(() => {
    const id = setTimeout(() => { if (text.trim() !== q) setParam('q', text.trim()) }, 350)
    return () => clearTimeout(id)
  }, [text]) // eslint-disable-line react-hooks/exhaustive-deps

  const query = new URLSearchParams({ page: String(page), pageSize: '20' })
  if (q) query.set('q', q)
  if (filter !== 'ALL') query.set('active', filter)
  const list = useApi(`/admin/coupons?${query}`)
  const rows = list.data?.data ?? []

  return (
    <div className="dp">
      <PageHead title="Cupons">
        {isAdmin && !creating && <button type="button" className="btn btn-sm btn-coin" onClick={() => setCreating(true)}><Plus size={16} weight="bold" aria-hidden="true" /> Novo cupom</button>}
      </PageHead>
      {!isAdmin && <ReadOnlyNote />}
      {creating && <CouponForm onDone={() => { setCreating(false); list.reload() }} onCancel={() => setCreating(false)} />}
      <div className="ad-toolbar">
        <label className="ad-search">
          <MagnifyingGlass size={18} aria-hidden="true" />
          <span className="sr-only">Buscar cupom</span>
          <input type="search" placeholder="Buscar pelo código" value={text} onChange={(e) => setText(e.target.value)} />
        </label>
      </div>
      <FilterChips label="Filtrar cupons" options={FILTERS} value={filter} onChange={(f) => setParam('situacao', f)} />

      {list.error ? <LoadError message={list.error} onRetry={list.reload} />
        : list.loading && !list.data ? <Skeleton lines={5} />
          : rows.length === 0 ? (
            <div className="dg-onboarding glass">
              <Ticket size={32} weight="duotone" aria-hidden="true" />
              <div className="dg-onboarding-copy">
                <h2 className="dh-section-title">{q || filter !== 'ALL' ? 'Nenhum cupom encontrado' : 'Nenhum cupom ainda'}</h2>
                <p className="dh-text">{q || filter !== 'ALL' ? 'Confira a busca ou o filtro.' : 'Crie um cupom para dar GetCoins em campanhas e parcerias.'}</p>
              </div>
            </div>
          ) : (
            <ul className="ad-list">{rows.map((c) => <CouponCard key={`${c.id}-${c.updatedAt}`} c={c} isAdmin={isAdmin} onChanged={list.reload} />)}</ul>
          )}
      <Pager meta={list.data?.meta} onPage={setPage} />
    </div>
  )
}
