import { useId, useState } from 'react'
import { ArrowRight, Check, CircleNotch, Eye, EyeSlash, WarningCircle } from '@phosphor-icons/react'

// Peças de formulário do mundo "carteira de vidro": campos em pílula, senha com mostrar/ocultar,
// botão moeda com estado de carregamento e alerta em tinta clara com ícone em ember.
export function ErrorLine({ id, children }) {
  return (
    <p className="af-error" id={id}><WarningCircle size={16} weight="fill" aria-hidden="true" />{children}</p>
  )
}

export function Field({ label, error, hint, aside, ...input }) {
  const id = useId()
  const noteId = `${id}-note`
  return (
    <div className="af-field">
      <div className="af-label-row">
        <label htmlFor={id}>{label}</label>
        {aside}
      </div>
      <input
        id={id}
        className="af-input"
        aria-invalid={error ? 'true' : undefined}
        aria-describedby={error || hint ? noteId : undefined}
        {...input}
      />
      {error ? <ErrorLine id={noteId}>{error}</ErrorLine> : hint ? <p className="af-hint" id={noteId}>{hint}</p> : null}
    </div>
  )
}

export function PasswordField({ label = 'Senha', error, hint, aside, ...input }) {
  const [shown, setShown] = useState(false)
  const id = useId()
  const noteId = `${id}-note`
  return (
    <div className="af-field">
      <div className="af-label-row">
        <label htmlFor={id}>{label}</label>
        {aside}
      </div>
      <div className="af-pass">
        <input
          id={id}
          className="af-input"
          type={shown ? 'text' : 'password'}
          aria-invalid={error ? 'true' : undefined}
          aria-describedby={error || hint ? noteId : undefined}
          {...input}
        />
        <button
          type="button"
          className="af-reveal"
          onClick={() => setShown((s) => !s)}
          aria-label={shown ? 'Ocultar senha' : 'Mostrar senha'}
          aria-pressed={shown}
        >
          {shown ? <EyeSlash size={20} /> : <Eye size={20} />}
        </button>
      </div>
      {error ? <ErrorLine id={noteId}>{error}</ErrorLine> : hint ? <div id={noteId}>{hint}</div> : null}
    </div>
  )
}

export function Submit({ busy, disabled = false, children, busyLabel }) {
  return (
    <button type="submit" className="btn btn-coin btn-lg btn-block af-submit" disabled={busy || disabled} aria-busy={busy}>
      {busy ? (
        <><CircleNotch size={20} className="af-spin" aria-hidden="true" />{busyLabel}</>
      ) : (
        <>{children}<ArrowRight size={18} weight="bold" aria-hidden="true" /></>
      )}
    </button>
  )
}

export function FormAlert({ children, tone = 'error' }) {
  if (!children) return null
  return (
    <div className={`af-alert af-alert-${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      {tone === 'error' ? <WarningCircle size={20} weight="fill" aria-hidden="true" /> : <Check size={20} weight="bold" aria-hidden="true" />}
      <div>{children}</div>
    </div>
  )
}
