import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft, CircleNotch, ClockCounterClockwise, Trophy, Wallet, Lightning } from '@phosphor-icons/react'
import { api, brl, coins, fieldErrors } from '../../lib/api.js'
import { useAuth } from '../../lib/auth.jsx'
import { useApi } from '../../lib/useApi.js'
import { Field } from '../../components/form.jsx'
import { Coin, LoadError, Skeleton, dateFmt, dayFmt } from '../dashboard/ui.jsx'
import { ReadOnlyNote, useIsAdmin } from './ui.jsx'
import { LEVEL, ROLE, STATUS, initials } from './Users.jsx'

const parseCents = (v) => {
  const d = String(v).replace(/\D/g, '')
  return d ? parseInt(d, 10) : 0
}
const maskCents = (v) => {
  const c = parseCents(v)
  return c ? (c / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 }) : ''
}
const phoneFmt = (p = '') => p.replace(/^(\d{2})(\d{4,5})(\d{4})$/, '($1) $2-$3')
const MAX_ADJUST = 10_000_000

const WALLETS = {
  coin: { label: 'GetCoin', path: 'wallet-adjustments', fmt: (c) => `${coins(c)} GetCoins` },
  cash: { label: 'Saldo em R$', path: 'cash-adjustments', fmt: brl },
}

function Segmented({ label, options, value, onChange }) {
  return (
    <div className="ad-seg" role="radiogroup" aria-label={label}>
      {options.map(([id, text]) => (
        <button key={id} type="button" role="radio" aria-checked={value === id} className={`ad-seg-btn ${value === id ? 'is-on' : ''}`} onClick={() => onChange(id)}>{text}</button>
      ))}
    </div>
  )
}

function ConfirmBar({ text, busy, error, onBack, confirmLabel, danger }) {
  return (
    <div className="ad-confirm" role="group">
      <p className="ad-confirm-text">{text}</p>
      {error && <p className="af-error" role="alert">{error}</p>}
      <div className="ad-confirm-actions">
        <button type="button" className="btn btn-sm btn-glass" onClick={onBack} disabled={busy}>Voltar</button>
        <button type="submit" className={`btn btn-sm ${danger ? 'btn-glass btn-danger' : 'btn-coin'}`} disabled={busy} aria-busy={busy}>
          {busy && <CircleNotch size={16} className="af-spin" aria-hidden="true" />}
          {confirmLabel}
        </button>
      </div>
    </div>
  )
}

/** Papel e situação da conta, sempre com motivo (vai para a auditoria). */
function AccessForm({ user, onDone }) {
  const [role, setRole] = useState(user.role)
  const [status, setStatus] = useState(user.status)
  const [reason, setReason] = useState('')
  const [errors, setErrors] = useState({})
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [alert, setAlert] = useState(null)
  const changed = role !== user.role || status !== user.status
  const suspends = status === 'SUSPENDED' && user.status !== 'SUSPENDED'

  const reset = () => { setRole(user.role); setStatus(user.status); setReason(''); setConfirming(false); setAlert(null) }

  async function submit(e) {
    e.preventDefault()
    if (!confirming) {
      const found = {}
      if (reason.trim().length < 3) found.reason = 'Explique o motivo (mínimo de 3 caracteres).'
      setErrors(found)
      if (!Object.keys(found).length) setConfirming(true)
      return
    }
    setBusy(true)
    setAlert(null)
    try {
      const body = { reason: reason.trim() }
      if (role !== user.role) body.role = role
      if (status !== user.status) body.status = status
      await api(`/admin/users/${user.id}`, { method: 'PATCH', body })
      setReason('')
      setConfirming(false)
      onDone()
    } catch (err) {
      const byField = fieldErrors(err)
      if (Object.keys(byField).length) { setErrors(byField); setConfirming(false) } else setAlert(err.message)
    } finally {
      setBusy(false)
    }
  }

  const parts = []
  if (role !== user.role) parts.push(`papel de ${ROLE[user.role][0]} para ${ROLE[role][0]}`)
  if (status !== user.status) parts.push(status === 'SUSPENDED' ? 'suspender a conta' : 'reativar a conta')
  const summary = `Confirmar: ${parts.join(' e ')}.`
    + (suspends ? ' A pessoa sai de todos os aparelhos e os anúncios dela no marketplace são cancelados.' : role !== user.role ? ' A pessoa precisa entrar de novo.' : '')

  return (
    <form className="ad-panel glass" onSubmit={submit} noValidate aria-labelledby="ad-access-title">
      <h2 className="dh-section-title" id="ad-access-title">Acesso</h2>
      <div className="ad-panel-row">
        <span className="ad-panel-label">Papel</span>
        <Segmented label="Papel" options={[['USER', 'Usuário'], ['SUPPORT', 'Suporte'], ['ADMIN', 'Admin']]} value={role} onChange={(v) => { setRole(v); setConfirming(false) }} />
      </div>
      <div className="ad-panel-row">
        <span className="ad-panel-label">Situação</span>
        <Segmented label="Situação" options={[['ACTIVE', 'Ativa'], ['SUSPENDED', 'Suspensa']]} value={status} onChange={(v) => { setStatus(v); setConfirming(false) }} />
      </div>
      {changed && (
        <>
          <Field label="Motivo" value={reason} maxLength={500} onChange={(e) => { setReason(e.target.value); setConfirming(false) }} error={errors.reason} placeholder="Ex.: pedido do cliente pelo suporte" hint="Fica registrado no histórico da conta." />
          {confirming ? (
            <ConfirmBar text={summary} busy={busy} error={alert} onBack={() => setConfirming(false)} confirmLabel={suspends ? 'Confirmar suspensão' : 'Confirmar'} danger={suspends} />
          ) : (
            <div className="ad-confirm-actions">
              <button type="button" className="btn btn-sm btn-glass" onClick={reset}>Desfazer</button>
              <button type="submit" className={`btn btn-sm ${suspends ? 'btn-glass btn-danger' : 'btn-coin'}`}>{suspends ? 'Suspender conta' : 'Salvar acesso'}</button>
            </div>
          )}
        </>
      )}
    </form>
  )
}

/** Crédito ou débito manual em GetCoin ou R$ (correções e atendimento). */
function AdjustForm({ user, onDone }) {
  const [wallet, setWallet] = useState('coin')
  const [direction, setDirection] = useState('credit')
  const [amount, setAmount] = useState('')
  const [reason, setReason] = useState('')
  const [errors, setErrors] = useState({})
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [alert, setAlert] = useState(null)
  const [done, setDone] = useState(null)

  const w = WALLETS[wallet]
  const cents = parseCents(amount)
  const current = wallet === 'coin' ? user.balanceCents : user.cashBalanceCents
  const after = current + (direction === 'credit' ? cents : -cents)
  const edit = (fn) => (v) => { fn(v); setConfirming(false); setDone(null) }

  async function submit(e) {
    e.preventDefault()
    if (!confirming) {
      const found = {}
      if (!cents) found.amountCents = 'Informe o valor.'
      else if (cents > MAX_ADJUST) found.amountCents = `O limite por ajuste é ${w.fmt(MAX_ADJUST)}.`
      else if (after < 0) found.amountCents = `O saldo atual é ${w.fmt(current)}: o débito não pode passar disso.`
      if (reason.trim().length < 5) found.reason = 'Explique o motivo (mínimo de 5 caracteres).'
      setErrors(found)
      if (!Object.keys(found).length) setConfirming(true)
      return
    }
    setBusy(true)
    setAlert(null)
    try {
      await api(`/admin/users/${user.id}/${w.path}`, { method: 'POST', body: { amountCents: direction === 'credit' ? cents : -cents, reason: reason.trim() } })
      setDone(`${direction === 'credit' ? 'Crédito' : 'Débito'} de ${w.fmt(cents)} feito.`)
      setAmount('')
      setReason('')
      setConfirming(false)
      onDone()
    } catch (err) {
      const byField = fieldErrors(err)
      if (Object.keys(byField).length) { setErrors(byField); setConfirming(false) } else setAlert(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="ad-panel glass" onSubmit={submit} noValidate aria-labelledby="ad-adjust-title">
      <h2 className="dh-section-title" id="ad-adjust-title">Ajuste de saldo</h2>
      <div className="ad-panel-row">
        <span className="ad-panel-label">Carteira</span>
        <Segmented label="Carteira" options={[['coin', 'GetCoin'], ['cash', 'R$']]} value={wallet} onChange={edit(setWallet)} />
      </div>
      <div className="ad-panel-row">
        <span className="ad-panel-label">Tipo</span>
        <Segmented label="Tipo de ajuste" options={[['credit', 'Crédito'], ['debit', 'Débito']]} value={direction} onChange={edit(setDirection)} />
      </div>
      <div className="ad-adjust-grid">
        <Field label={wallet === 'coin' ? 'Valor (GetCoins)' : 'Valor (R$)'} inputMode="numeric" placeholder="0,00" value={amount} className="af-input mono" onChange={(e) => edit(setAmount)(maskCents(e.target.value))} error={errors.amountCents} hint={cents ? `Saldo fica em ${w.fmt(after)}` : `Saldo atual: ${w.fmt(current)}`} />
        <Field label="Motivo" value={reason} maxLength={500} onChange={(e) => edit(setReason)(e.target.value)} error={errors.reason} placeholder="Ex.: compensação pelo atendimento #123" />
      </div>
      {confirming ? (
        <ConfirmBar
          text={`${direction === 'credit' ? 'Creditar' : 'Debitar'} ${w.fmt(cents)} ${direction === 'credit' ? 'para' : 'de'} ${user.name}? O saldo vai de ${w.fmt(current)} para ${w.fmt(after)}. O ajuste não pode ser apagado, só compensado por outro.`}
          busy={busy} error={alert} onBack={() => setConfirming(false)} confirmLabel={direction === 'credit' ? 'Confirmar crédito' : 'Confirmar débito'} danger={direction === 'debit'}
        />
      ) : (
        <div className="ad-confirm-actions">
          {done && <p className="ad-done" role="status">{done}</p>}
          <button type="submit" className="btn btn-sm btn-coin">Revisar ajuste</button>
        </div>
      )}
    </form>
  )
}

const ACTIONS = {
  USER_UPDATED: 'Acesso alterado',
  WALLET_ADJUSTED: 'Ajuste de GetCoin',
  CASH_ADJUSTED: 'Ajuste de saldo em R$',
  MARKET_LISTINGS_CANCELLED_ON_SUSPEND: 'Anúncios cancelados pela suspensão',
  USER_REGISTERED: 'Conta criada',
  EMAIL_VERIFIED: 'E-mail confirmado',
  LOGIN_SUCCEEDED: 'Entrou na conta',
  LOGIN_FAILED: 'Tentativa de login com senha errada',
  LOGIN_BLOCKED: 'Login bloqueado por excesso de tentativas',
  LOGOUT_ALL: 'Saiu de todos os aparelhos',
  REFRESH_TOKEN_REUSE: 'Sessão reutilizada (possível vazamento): sessões encerradas',
  PASSWORD_CHANGED: 'Senha alterada',
  PASSWORD_RESET_REQUESTED: 'Pediu redefinição de senha',
  PASSWORD_RESET: 'Senha redefinida',
  PROFILE_UPDATED: 'Perfil atualizado',
  ADDRESS_UPDATED: 'Endereço atualizado',
  ACCOUNT_DELETED: 'Conta excluída (LGPD)',
}

function describe(log) {
  const m = log.metadata ?? {}
  if (log.action === 'USER_UPDATED' && m.from && m.to) {
    const bits = []
    if (m.from.role !== m.to.role) bits.push(`${ROLE[m.from.role]?.[0] ?? m.from.role} → ${ROLE[m.to.role]?.[0] ?? m.to.role}`)
    if (m.from.status !== m.to.status) bits.push(`${STATUS[m.from.status]?.[0] ?? m.from.status} → ${STATUS[m.to.status]?.[0] ?? m.to.status}`)
    return [bits.join(' · '), m.reason]
  }
  if (log.action === 'WALLET_ADJUSTED') return [`${m.amountCents > 0 ? '+' : '−'}${coins(Math.abs(m.amountCents))} GetCoins`, m.reason]
  if (log.action === 'CASH_ADJUSTED') return [`${m.amountCents > 0 ? '+' : '−'}${brl(Math.abs(m.amountCents))}`, m.reason]
  if (log.action === 'MARKET_LISTINGS_CANCELLED_ON_SUSPEND') return [`${m.listingIds?.length ?? 0} anúncio(s) · ${coins(m.returnedCents ?? 0)} GetCoins devolvidos`, null]
  return [null, null]
}

function History({ userId }) {
  const [page, setPage] = useState(1)
  const logs = useApi(`/admin/audit-logs?entityId=${userId}&page=${page}&pageSize=10`)
  const rows = logs.data?.data ?? []
  const totalPages = Math.max(1, Math.ceil((logs.data?.meta.total ?? 0) / 10))
  return (
    <section className="ad-panel glass" aria-labelledby="ad-history-title">
      <h2 className="dh-section-title" id="ad-history-title">Histórico da conta</h2>
      {logs.error ? <LoadError message={logs.error} onRetry={logs.reload} />
        : logs.loading && !logs.data ? <Skeleton lines={3} />
          : rows.length === 0 ? <p className="ad-item-note">Nada registrado nesta conta ainda.</p>
            : (
              <ol className="ad-log">
                {rows.map((l) => {
                  const [what, why] = describe(l)
                  return (
                    <li key={l.id}>
                      <ClockCounterClockwise size={16} aria-hidden="true" />
                      <div>
                        <p className="ad-log-title">{ACTIONS[l.action] ?? l.action}{what && <> · <span className="mono">{what}</span></>}</p>
                        {why && <p className="ad-log-why">“{why}”</p>}
                        <p className="ad-who-meta"><span className="mono">{dateFmt.format(new Date(l.createdAt))}</span>{l.actorName ? ` · por ${l.actorName}` : ''}</p>
                      </div>
                    </li>
                  )
                })}
              </ol>
            )}
      {totalPages > 1 && (
        <div className="ad-confirm-actions">
          <button type="button" className="btn btn-sm btn-glass" disabled={page <= 1} onClick={() => setPage(page - 1)}>Mais recentes</button>
          <button type="button" className="btn btn-sm btn-glass" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>Mais antigas</button>
        </div>
      )}
    </section>
  )
}

export default function UserDetail() {
  const { id } = useParams()
  const isAdmin = useIsAdmin()
  const { user: me } = useAuth()
  const detail = useApi(`/admin/users/${id}`)
  const [historyKey, setHistoryKey] = useState(0)
  const u = detail.data?.data
  const changed = () => { detail.reload(); setHistoryKey((k) => k + 1) }

  const back = <Link to="/admin/usuarios" className="ad-back"><ArrowLeft size={16} aria-hidden="true" /> Usuários</Link>
  if (detail.error) return <div className="dp">{back}<LoadError message={detail.error} onRetry={detail.reload} /></div>
  if (!u) return <div className="dp">{back}<Skeleton lines={8} /></div>

  const [roleLabel, roleTone] = ROLE[u.role] ?? [u.role, 'off']
  const [stLabel, stTone] = STATUS[u.status] ?? [u.status, 'off']
  const self = me?.id === u.id
  const locked = u.lockedUntil && new Date(u.lockedUntil) > new Date()

  return (
    <div className="dp">
      {back}
      <section className="ad-profile glass">
        <span className="mk-avatar ad-profile-avatar" aria-hidden="true">{initials(u.name)}</span>
        <div className="ad-profile-main">
          <h1 className="ad-profile-name">{u.name}</h1>
          <p className="ad-who-meta">{u.email}</p>
          <div className="ad-user-tags">
            <span className="ad-level">{LEVEL[u.level] ?? u.level}</span>
            <span className={`dg-pill dg-pill-${roleTone}`}>{roleLabel}</span>
            <span className={`dg-pill dg-pill-${stTone}`}>{stLabel}</span>
          </div>
        </div>
        <dl className="ad-facts">
          <div><dt>Cadastro</dt><dd className="mono">{dayFmt.format(new Date(u.createdAt))}</dd></div>
          <div><dt>E-mail</dt><dd>{u.emailVerifiedAt ? <>Confirmado em <span className="mono">{dayFmt.format(new Date(u.emailVerifiedAt))}</span></> : 'Não confirmado'}</dd></div>
          <div><dt>CPF</dt><dd className={u.cpfMasked ? 'mono' : undefined}>{u.cpfMasked ?? 'Não informado'}</dd></div>
          <div><dt>Telefone</dt><dd className="mono">{u.phone ? phoneFmt(u.phone) : '—'}</dd></div>
          <div><dt>Indicação</dt><dd className="mono">{u.referralCode ?? '—'}</dd></div>
          <div><dt>Login</dt><dd>{locked ? <>Bloqueado até <span className="mono">{dateFmt.format(new Date(u.lockedUntil))}</span></> : u.failedLoginCount ? <><span className="mono">{u.failedLoginCount}</span> tentativa(s) falha(s)</> : 'Normal'}</dd></div>
        </dl>
      </section>

      <dl className="ad-kpis">
        <div className="ad-kpi glass"><dt><span className="ad-kpi-icon"><Coin size="sm" /></span>GetCoins</dt><dd className="mono">{coins(u.balanceCents)}</dd></div>
        <div className="ad-kpi glass"><dt><span className="ad-kpi-icon"><Wallet size={15} aria-hidden="true" /></span>Saldo em R$</dt><dd className="mono">{brl(u.cashBalanceCents)}</dd></div>
        <div className="ad-kpi glass"><dt><span className="ad-kpi-icon"><Lightning size={15} aria-hidden="true" /></span>Gets</dt><dd className="mono">{u.getsCount}</dd></div>
        <div className="ad-kpi glass"><dt><span className="ad-kpi-icon"><Trophy size={15} aria-hidden="true" /></span>Vitórias</dt><dd className="mono">{u.wins}</dd></div>
      </dl>

      {u.status === 'DELETED' ? (
        <p className="ad-readonly">Conta excluída a pedido do titular (LGPD). Os dados pessoais foram anonimizados e nada mais pode ser alterado.</p>
      ) : !isAdmin ? (
        <ReadOnlyNote />
      ) : self ? (
        <p className="ad-readonly">Esta é a sua conta. Papel, situação e saldos só podem ser alterados por outro administrador.</p>
      ) : (
        <div className="ad-panels">
          <AccessForm key={`${u.role}-${u.status}`} user={u} onDone={changed} />
          <AdjustForm user={u} onDone={changed} />
        </div>
      )}

      <History key={historyKey} userId={u.id} />
    </div>
  )
}
