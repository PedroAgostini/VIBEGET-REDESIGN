import { useCallback, useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion, MotionConfig } from 'framer-motion'
import { useSearchParams } from 'react-router-dom'
import { ArrowClockwise, CaretDown, MagnifyingGlass, X } from '@phosphor-icons/react'
import { api } from '../lib/api.js'
import { categories } from '../data.js'
import { Footer, Nav, useNow } from '../App.jsx'
import VibeCard from '../components/VibeCard.jsx'

// Pílulas (situação e categoria): transição curta, sem passar do ponto, igual às abas do resto do site.
const pillMove = { duration: 0.4, ease: [0.16, 1, 0.3, 1] }
const PAGE_SIZE = 12

const STATUS_TABS = [
  { id: 'LIVE', label: 'Ao vivo' },
  { id: 'SCHEDULED', label: 'Em breve' },
  { id: 'ENDED', label: 'Encerradas' },
]
const SORTS = [
  { id: 'ending', label: 'Terminam primeiro' },
  { id: 'newest', label: 'Mais recentes' },
  { id: 'min-get', label: 'Menor Get mínimo' },
  { id: 'price-high', label: 'Maior valor na loja' },
  { id: 'price-low', label: 'Menor valor na loja' },
]
const HEADLINE = {
  LIVE: (n) => (n === 1 ? '1 Vibe ao vivo' : `${n} Vibes ao vivo`),
  SCHEDULED: (n) => (n === 1 ? '1 Vibe abre em breve' : `${n} Vibes abrem em breve`),
  ENDED: (n) => (n === 1 ? '1 Vibe encerrada' : `${n} Vibes encerradas`),
}

function SkeletonCard() {
  return (
    <div className="vibe glass vp-skel" aria-hidden="true">
      <span className="vp-skel-media" />
      <span className="vp-skel-line" />
      <span className="vp-skel-line is-short" />
      <span className="vp-skel-line is-btn" />
    </div>
  )
}

export default function VibesPage() {
  const now = useNow()
  const [params, setParams] = useSearchParams()
  const status = STATUS_TABS.some((s) => s.id === params.get('status')) ? params.get('status') : 'LIVE'
  const category = categories.some((c) => c.id === params.get('categoria')) ? params.get('categoria') : 'todos'
  const sort = SORTS.some((s) => s.id === params.get('ordem')) ? params.get('ordem') : 'ending'
  const q = (params.get('q') ?? '').trim()

  const [query, setQuery] = useState(q)
  const [state, setState] = useState({ items: [], meta: null, facets: {}, loading: true, error: null, more: false })
  const request = useRef(0)

  // Filtros no endereço: o link filtrado pode ser compartilhado.
  const setParam = useCallback((key, value) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev)
      if (value) next.set(key, value)
      else next.delete(key)
      return next
    }, { replace: true })
  }, [setParams])

  // Busca com espera de 300 ms entre teclas.
  useEffect(() => {
    const id = setTimeout(() => { if (query.trim() !== q) setParam('q', query.trim()) }, 300)
    return () => clearTimeout(id)
  }, [query, q, setParam])

  const load = useCallback(async (page) => {
    const id = ++request.current
    const search = new URLSearchParams({ status, sort, page: String(page), pageSize: String(PAGE_SIZE) })
    if (category !== 'todos') search.set('category', category)
    if (q) search.set('q', q)
    setState((s) => ({ ...s, loading: page === 1, more: page > 1, error: null }))
    try {
      const res = await api(`/vibes?${search}`)
      if (id !== request.current) return // resposta antiga: o filtro mudou no meio
      setState((s) => ({
        items: page === 1 ? res.data : [...s.items, ...res.data],
        meta: res.meta,
        facets: res.facets ?? {},
        loading: false,
        more: false,
        error: null,
      }))
    } catch (err) {
      if (id !== request.current) return
      setState((s) => ({ ...s, loading: false, more: false, error: err.message }))
    }
  }, [status, sort, category, q])

  useEffect(() => { load(1) }, [load])

  const { items, meta, facets, loading, error, more } = state
  const total = meta?.total ?? 0
  const allCount = Object.values(facets).reduce((a, b) => a + b, 0)
  const hasMore = meta ? meta.page * meta.pageSize < meta.total : false
  const filtered = Boolean(q) || category !== 'todos'
  const catLabel = categories.find((c) => c.id === category)?.label

  function clearFilters() {
    setQuery('')
    setParams((prev) => {
      const next = new URLSearchParams(prev)
      next.delete('q')
      next.delete('categoria')
      return next
    }, { replace: true })
  }

  return (
    <MotionConfig reducedMotion="user">
      <a className="skip-link" href="#main">Pular para o conteúdo</a>
      <div className="atmos" aria-hidden="true" />
      <Nav current="vibes" />
      <main id="main" className="vp">
        <header className="vp-head">
          <h1 className="vp-title">Vibes</h1>
          <p className="vp-lede">
            Eletrônicos novos, lacrados e com garantia. Dê seu Get: quem não vence recebe 40% do valor pago de volta em GetCoin.
          </p>
        </header>

        <div className="vp-tools glass">
          <label className="vp-search">
            <MagnifyingGlass size={20} aria-hidden="true" />
            <span className="sr-only">Buscar produto</span>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Buscar produto, ex.: iPhone"
              maxLength={80}
              autoComplete="off"
            />
            {query && (
              <button type="button" className="vp-clear" onClick={() => setQuery('')} aria-label="Limpar busca">
                <X size={16} weight="bold" />
              </button>
            )}
          </label>

          <div className="vp-status" role="tablist" aria-label="Situação das Vibes">
            {STATUS_TABS.map((s) => (
              <button
                key={s.id}
                type="button"
                role="tab"
                aria-selected={status === s.id}
                className="vp-status-btn"
                onClick={() => setParam('status', s.id === 'LIVE' ? '' : s.id)}
              >
                {status === s.id && <motion.span layoutId="vp-status-pill" className="vp-status-pill" transition={pillMove} />}
                <span className="vp-status-label">
                  {s.id === 'LIVE' && <span className="live-dot" aria-hidden="true" />}
                  {s.label}
                </span>
              </button>
            ))}
          </div>

          <label className="vp-sort">
            <span className="sr-only">Ordenar por</span>
            <select value={sort} onChange={(e) => setParam('ordem', e.target.value === 'ending' ? '' : e.target.value)}>
              {SORTS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select>
            <CaretDown size={14} weight="bold" aria-hidden="true" />
          </label>
        </div>

        <div className="chips vp-chips" role="tablist" aria-label="Categorias">
          {categories.map((c) => (
            <button
              key={c.id}
              type="button"
              role="tab"
              aria-selected={category === c.id}
              className={`chip ${category === c.id ? 'is-on' : ''}`}
              onClick={(e) => {
                setParam('categoria', c.id === 'todos' ? '' : c.id)
                e.currentTarget.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' })
              }}
            >
              {category === c.id && <motion.span layoutId="vp-chip-pill" className="chip-pill" transition={pillMove} />}
              <span className="chip-label">{c.label}</span>
              <span className="chip-count mono">{c.id === 'todos' ? allCount : facets[c.id] ?? 0}</span>
            </button>
          ))}
        </div>

        <p className="vp-count" aria-live="polite">
          {loading ? 'Carregando Vibes…' : error ? '' : HEADLINE[status](total)}
          {!loading && !error && q ? <> para <b>“{q}”</b></> : null}
          {!loading && !error && category !== 'todos' ? <> em <b>{catLabel}</b></> : null}
        </p>

        {error ? (
          <div className="vp-empty glass" role="alert">
            <h2>Não foi possível carregar as Vibes.</h2>
            <p className="muted">{error}</p>
            <button type="button" className="btn btn-glass" onClick={() => load(1)}><ArrowClockwise size={18} aria-hidden="true" />Tentar de novo</button>
          </div>
        ) : loading ? (
          <div className="vibe-grid vp-grid">{Array.from({ length: 8 }, (_, i) => <SkeletonCard key={i} />)}</div>
        ) : items.length === 0 ? (
          <div className="vp-empty glass">
            <h2>{filtered ? 'Nenhuma Vibe encontrada.' : status === 'LIVE' ? 'Nenhuma Vibe ao vivo agora.' : status === 'SCHEDULED' ? 'Nenhuma Vibe agendada.' : 'Nenhuma Vibe encerrada ainda.'}</h2>
            <p className="muted">
              {filtered ? 'Tente outro termo ou outra categoria.' : 'Novas Vibes abrem sem hora marcada. Volte daqui a pouco ou veja as que abrem em breve.'}
            </p>
            {filtered ? (
              <button type="button" className="btn btn-glass" onClick={clearFilters}>Limpar filtros</button>
            ) : status === 'LIVE' ? (
              <button type="button" className="btn btn-glass" onClick={() => setParam('status', 'SCHEDULED')}>Ver as que abrem em breve</button>
            ) : null}
          </div>
        ) : (
          <>
            <motion.div layout className="vibe-grid vp-grid">
              <AnimatePresence mode="popLayout" initial={false}>
                {items.map((v) => <VibeCard key={v.id} v={v} now={now} />)}
              </AnimatePresence>
            </motion.div>
            {hasMore && (
              <div className="vp-more">
                <button type="button" className="btn btn-glass btn-lg" onClick={() => load(meta.page + 1)} disabled={more}>
                  {more ? 'Carregando…' : 'Carregar mais Vibes'}
                </button>
                <span className="muted small mono">{items.length}/{total}</span>
              </div>
            )}
          </>
        )}
      </main>
      <Footer />
    </MotionConfig>
  )
}
