import { CaretLeft, CaretRight, WarningCircle } from '@phosphor-icons/react'
import GetCoin from '../../components/Coin.jsx'

// Peças compartilhadas pelas páginas do dashboard.

export const dateFmt = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
export const dayFmt = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' })

export { LEVELS } from '../../lib/levels.js'

/** A mesma GetCoin da home, dimensionada pelo tamanho do texto ao lado (em). */
export function Coin({ size = 'md' }) {
  return <GetCoin className={`dash-coin dash-coin-${size}`} />
}

export function PageHead({ title, children }) {
  return (
    <header className="dp-head">
      <h1 className="dp-title">{title}</h1>
      {children && <div className="dp-head-aside">{children}</div>}
    </header>
  )
}

export function LoadError({ message, onRetry }) {
  return (
    <div className="af-alert af-alert-error" role="alert">
      <WarningCircle size={20} weight="fill" aria-hidden="true" />
      <div>
        {message}{' '}
        {onRetry && <button type="button" className="af-inline-link" onClick={onRetry}>Tentar de novo</button>}
      </div>
    </div>
  )
}

export function Skeleton({ lines = 3 }) {
  return (
    <div className="dp-skeleton" aria-hidden="true">
      {Array.from({ length: lines }, (_, i) => <span key={i} />)}
    </div>
  )
}

export function Pager({ meta, onPage }) {
  if (!meta || meta.total <= meta.pageSize) return null
  const pages = Math.ceil(meta.total / meta.pageSize)
  return (
    <nav className="dp-pager" aria-label="Paginação">
      <button type="button" className="btn btn-glass btn-sm" disabled={meta.page <= 1} onClick={() => onPage(meta.page - 1)}>
        <CaretLeft size={16} aria-hidden="true" />Anterior
      </button>
      <span className="mono">{meta.page}/{pages}</span>
      <button type="button" className="btn btn-glass btn-sm" disabled={meta.page >= pages} onClick={() => onPage(meta.page + 1)}>
        Próxima<CaretRight size={16} aria-hidden="true" />
      </button>
    </nav>
  )
}
