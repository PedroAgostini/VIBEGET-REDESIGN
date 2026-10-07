import { motion } from 'framer-motion'
import { ArrowRight, CalendarBlank, Package, Timer, Trophy } from '@phosphor-icons/react'
import { brl } from '../lib/api.js'
import { countdown, spotlight } from '../App.jsx'

const spring = { type: 'spring', stiffness: 100, damping: 20 }
const CLOSING_MS = 3 * 3600 * 1000

export const CAT_LABEL = { smartphones: 'Smartphone', notebooks: 'Notebook', games: 'Games', audio: 'Áudio', wearables: 'Wearable' }

/**
 * Cartão de uma Vibe vinda da API (GET /vibes). Mesmo vocabulário visual dos cartões da home:
 * pedestal creme com a foto, relógio, maior Get, desconto sobre a loja e meta de Gets.
 */
export default function VibeCard({ v, now }) {
  const p = v.product
  const href = `/vibes/${v.slug}`
  const live = v.status === 'LIVE'
  const scheduled = v.status === 'SCHEDULED'
  const closeAt = new Date(v.getsCloseAt ?? v.endsAt).getTime()
  const left = closeAt - now
  const closing = live && left < CLOSING_MS
  const top = v.topGet?.totalCents
  const shown = top ?? v.minGetCents
  // Arredonda para baixo: 99,96% nunca vira "100% abaixo".
  const below = p.originalPriceCents ? Math.max(0, Math.floor((1 - shown / p.originalPriceCents) * 100)) : null
  const progress = v.goalGets ? Math.min(100, (v.confirmedGets / v.goalGets) * 100) : null

  let chip
  if (live) {
    chip = (
      <span className={`chip-time mono ${closing ? 'is-closing' : ''}`}>
        {closing ? <span className="live-dot" /> : <Timer size={13} />} {left > 0 ? countdown(left) : 'Encerrando'}
      </span>
    )
  } else if (scheduled) {
    chip = (
      <span className="chip-time mono">
        <CalendarBlank size={13} /> Abre em {countdown(new Date(v.startsAt).getTime() - now)}
      </span>
    )
  } else {
    chip = <span className="chip-time">Encerrada</span>
  }

  const priceLabel = v.status === 'ENDED' ? (top ? 'Champion Get' : 'Sem Gets') : top ? 'Maior Get' : 'Get mínimo'
  const cta = live ? (closing ? 'Dar Get agora' : 'Dar Get') : scheduled ? 'Ver detalhes' : 'Ver resultado'

  return (
    <motion.article
      layout
      initial={{ opacity: 0, y: 24 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.96 }}
      transition={spring}
      className={`vibe glass spot ${closing ? 'is-closing' : ''} ${v.status === 'ENDED' ? 'is-ended' : ''}`}
      onPointerMove={spotlight}
    >
      <a href={href} className={`plate vibe-media ${p.imageUrl ? '' : 'is-loaded is-empty'}`} tabIndex={-1} aria-hidden="true">
        {p.imageUrl ? (
          <img src={p.imageUrl} alt="" loading="lazy" onLoad={(e) => e.currentTarget.parentElement.classList.add('is-loaded')} />
        ) : (
          <Package size={44} weight="duotone" className="vibe-noimg" />
        )}
        {chip}
      </a>
      <div className="vibe-body">
        <div className="vibe-title">
          <span className="vibe-cat">{CAT_LABEL[p.category] ?? p.category}</span>
          <h3><a href={href}>{p.name}</a></h3>
        </div>
        <div className="vibe-price">
          <span className="muted small">
            {v.status === 'ENDED' && top ? <Trophy size={13} weight="fill" className="vibe-champ" aria-hidden="true" /> : null}
            {priceLabel}
          </span>
          <b className="mono price">{v.status === 'ENDED' && !top ? '—' : brl(shown)}</b>
          {p.originalPriceCents ? (
            <span className="vibe-save small">
              {below != null && v.status !== 'ENDED' ? <><b>{below}% abaixo</b> da loja<span className="sep"> · </span></> : 'Na loja '}
              <s className="mono">{brl(p.originalPriceCents)}</s>
            </span>
          ) : null}
        </div>
        <div className="meter" role={progress != null ? 'img' : undefined} aria-label={progress != null ? `${v.confirmedGets} de ${v.goalGets} Gets` : undefined}>
          {progress != null && <div className="meter-bar"><span style={{ transform: `scaleX(${progress / 100})` }} /></div>}
          <span className="meter-label small muted">
            <span><b className="ink mono">{v.confirmedGets}</b>{v.goalGets ? `/${v.goalGets}` : ''} Gets</span>
            <span>{live ? (closing ? 'Encerrando' : 'Aberta') : scheduled ? 'Em breve' : 'Encerrada'}</span>
          </span>
        </div>
        <a className={`btn btn-block vibe-cta ${closing ? 'btn-coin' : 'btn-glass'}`} href={href}>
          {cta} <ArrowRight size={17} weight="bold" />
        </a>
      </div>
    </motion.article>
  )
}
