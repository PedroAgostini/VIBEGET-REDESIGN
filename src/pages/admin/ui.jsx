import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { CircleNotch } from '@phosphor-icons/react'
import { useAuth } from '../../lib/auth.jsx'

export const useIsAdmin = () => useAuth().user?.role === 'ADMIN'

/** Filtro por status guardado na URL (?status=), para o link do painel abrir já filtrado. */
export function useStatusFilter(options, fallback) {
  const [params, setParams] = useSearchParams()
  const raw = params.get('status')
  const value = options.some(([id]) => id === raw) ? raw : fallback
  const set = (id) => setParams(id === fallback ? {} : { status: id }, { replace: true })
  return [value, set]
}

export function FilterChips({ options, value, onChange, counts = {}, label }) {
  return (
    <div className="ad-filter" role="group" aria-label={label}>
      {options.map(([id, text]) => (
        <button key={id} type="button" className={`ad-filter-btn ${value === id ? 'is-on' : ''}`} aria-pressed={value === id} onClick={() => onChange(id)}>
          {text}
          {counts[id] != null && <span className="mono ad-filter-n">{counts[id]}</span>}
        </button>
      ))}
    </div>
  )
}

/**
 * Ação com confirmação em dois passos (sem modal): o primeiro clique troca o botão por
 * "Confirmar" + "Voltar". Para ações que mexem com dinheiro ou não têm volta.
 */
export function ConfirmAction({ label, confirmLabel, warning, onConfirm, tone = 'glass', disabled }) {
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  async function run() {
    setBusy(true)
    setError(null)
    try {
      await onConfirm()
      setAsking(false)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  if (!asking) {
    return (
      <button type="button" className={`btn btn-sm btn-glass ${tone === 'danger' ? 'btn-danger' : ''}`} onClick={() => setAsking(true)} disabled={disabled}>{label}</button>
    )
  }
  return (
    <div className="ad-confirm" role="group" aria-label={label}>
      {warning && <p className="ad-confirm-text">{warning}</p>}
      {error && <p className="af-error" role="alert">{error}</p>}
      <div className="ad-confirm-actions">
        <button type="button" className="btn btn-sm btn-glass" onClick={() => { setAsking(false); setError(null) }} disabled={busy}>Voltar</button>
        <button type="button" className={`btn btn-sm ${tone === 'danger' ? 'btn-glass btn-danger' : 'btn-coin'}`} onClick={run} disabled={busy} aria-busy={busy}>
          {busy && <CircleNotch size={16} className="af-spin" aria-hidden="true" />}
          {confirmLabel}
        </button>
      </div>
    </div>
  )
}

export function ReadOnlyNote() {
  return <p className="ad-readonly">Seu acesso é de suporte: você vê tudo, mas as ações ficam com o administrador.</p>
}
