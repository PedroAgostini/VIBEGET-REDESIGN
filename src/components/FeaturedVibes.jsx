import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowRight } from '@phosphor-icons/react'
import { api } from '../lib/api.js'
import { useNow } from '../App.jsx'
import VibeCard from './VibeCard.jsx'

/**
 * "Mais Vibes em destaque": Vibes ao vivo que terminam primeiro, sem a Vibe atual.
 * Some sozinho quando não há outras Vibes ao vivo (nada de seção vazia).
 */
export default function FeaturedVibes({ excludeId, title = 'Mais Vibes em destaque', limit = 4 }) {
  const now = useNow()
  const [items, setItems] = useState(null)

  useEffect(() => {
    let alive = true
    api(`/vibes?status=LIVE&sort=ending&pageSize=${limit + 1}`)
      .then((res) => alive && setItems(res.data.filter((v) => v.id !== excludeId).slice(0, limit)))
      .catch(() => alive && setItems([]))
    return () => { alive = false }
  }, [excludeId, limit])

  if (!items || items.length === 0) return null
  return (
    <section className="vd-block vf" aria-labelledby="vf-title">
      <div className="vf-head">
        <h2 id="vf-title" className="vd-h2">{title}</h2>
        <Link to="/vibes" className="text-link">Ver todas<ArrowRight size={16} aria-hidden="true" /></Link>
      </div>
      <div className="vibe-grid vp-grid">
        {items.map((v) => <VibeCard key={v.id} v={v} now={now} />)}
      </div>
    </section>
  )
}
