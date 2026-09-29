import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { motion } from 'framer-motion'
import { ArrowRight, ArrowUpRight, Gavel, Heart, Trophy } from '@phosphor-icons/react'
import { brl, coins } from '../../lib/api.js'
import { useApi } from '../../lib/useApi.js'
import VibeCard from '../../components/VibeCard.jsx'
import PrizesSection from './Prizes.jsx'
import { LoadError, PageHead, Pager, Skeleton, dateFmt } from './ui.jsx'

function FavoritesSection({ now }) {
  const fav = useApi('/me/favorites/vibes')
  const list = fav.data?.data ?? []
  return (
    <section className="dg-section" aria-label="Vibes favoritas">
      {fav.error ? <LoadError message={fav.error} onRetry={fav.reload} />
        : fav.loading && !fav.data ? <Skeleton lines={3} />
          : list.length === 0 ? (
            <section className="dg-onboarding glass" aria-label="Nenhuma favorita ainda">
              <Heart size={34} weight="duotone" className="dg-heart" aria-hidden="true" />
              <div className="dg-onboarding-copy">
                <h2 className="dh-section-title">Nenhuma favorita ainda</h2>
                <p className="dh-text">Toque no coração na página de uma Vibe para acompanhar ela daqui.</p>
              </div>
              <Link className="btn btn-glass" to="/vibes">Ver Vibes<ArrowRight size={18} weight="bold" aria-hidden="true" /></Link>
            </section>
          ) : (
            <div className={`vibe-grid vp-grid n-${Math.min(list.length, 4)}`}>
              {list.map((v) => <VibeCard key={v.id} v={v} now={now} />)}
            </div>
          )}
    </section>
  )
}

const GET_STATUS = {
  CONFIRMED: ['Confirmado', 'ok'],
  PENDING_PAYMENT: ['Aguardando pagamento', 'wait'],
  FAILED: ['Pagamento não concluído', 'off'],
  REFUNDED: ['Estornado', 'off'],
}
const VIBE_STATUS = { LIVE: 'Ao vivo', ENDED: 'Encerrada', CANCELLED: 'Cancelada', SCHEDULED: 'Agendada', DRAFT: 'Rascunho' }

function useNow(ms = 1000) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(id)
  }, [ms])
  return now
}

function Countdown({ until, now }) {
  const left = Math.max(0, new Date(until).getTime() - now)
  const h = Math.floor(left / 3.6e6)
  const m = Math.floor((left % 3.6e6) / 6e4)
  const s = Math.floor((left % 6e4) / 1000)
  const d = Math.floor(h / 24)
  const text = left === 0 ? 'encerrando' : d > 0 ? `${d}d ${h % 24}h` : `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return <time className="mono" dateTime={new Date(until).toISOString()}>{text}</time>
}

function LeadingCard({ item, now }) {
  const closeAt = item.vibe.getsCloseAt ?? item.vibe.endsAt
  const closing = new Date(closeAt).getTime() - now < 3.6e6
  return (
    <li className="dg-lead glass">
      <div className="dg-lead-plate">
        {item.product.imageUrl && <img src={item.product.imageUrl} alt="" loading="lazy" />}
      </div>
      <div className="dg-lead-body">
        <p className="dg-lead-badge"><span className="dg-live-dot" aria-hidden="true" />Você está vencendo</p>
        <h3 className="dg-lead-name">{item.product.name}</h3>
        <dl className="dg-lead-figs">
          <div><dt>Seu maior Get</dt><dd className="mono">{brl(item.myTopGet.totalCents)}</dd></div>
          <div className={closing ? 'is-closing' : ''}><dt>Gets até</dt><dd><Countdown until={closeAt} now={now} /></dd></div>
        </dl>
        <a className="text-link" href={`/vibes/${item.vibe.slug}`}>Ver a Vibe<ArrowUpRight size={16} aria-hidden="true" /></a>
      </div>
    </li>
  )
}

function ExploreCta({ title, text }) {
  return (
    <section className="dg-onboarding glass" aria-label={title}>
      <Gavel size={34} weight="duotone" aria-hidden="true" />
      <div className="dg-onboarding-copy">
        <h2 className="dh-section-title">{title}</h2>
        <p className="dh-text">{text}</p>
      </div>
      <Link className="btn btn-coin" to="/vibes">Explorar Vibes<ArrowRight size={18} weight="bold" aria-hidden="true" /></Link>
    </section>
  )
}

function DisputeTab({ now, summary }) {
  const leading = useApi('/me/gets/leading')
  const leadList = leading.data?.data ?? []
  if (summary && summary.participated === 0) {
    return <ExploreCta title="Seu primeiro Get começa em uma Vibe aberta" text="Escolha um produto, defina o valor do seu Get e entre na disputa. Depois, todo o acompanhamento aparece aqui." />
  }
  if (leading.error) return <LoadError message={leading.error} onRetry={leading.reload} />
  if (leading.loading && !leading.data) return <Skeleton lines={3} />
  return (
    <>
      <section className="dg-section" aria-labelledby="dg-lead-title">
        <h2 id="dg-lead-title" className="dh-section-title">
          <Trophy size={20} weight="fill" className="dg-trophy" aria-hidden="true" />
          Você está vencendo <span className="mono dg-count">{leadList.length}</span>
        </h2>
        {leadList.length === 0 ? (
          <div className="dg-inline-empty">
            <p className="dg-inline-empty-title">Nenhuma liderança agora</p>
            <p>{summary?.active ? 'Alguém passou o seu Get. Dê um Get maior para voltar à frente.' : 'Quando o seu Get for o maior de uma Vibe ao vivo, ela aparece aqui.'}</p>
          </div>
        ) : (
          <ul className="dg-leads">{leadList.map((item) => <LeadingCard key={item.vibe.id} item={item} now={now} />)}</ul>
        )}
      </section>
      {summary && summary.active === 0 && (
        <ExploreCta title="Nenhuma disputa ao vivo" text="Você não tem Gets em Vibes abertas agora. Escolha um produto e volte para a disputa." />
      )}
    </>
  )
}

function HistoryTab() {
  const [page, setPage] = useState(1)
  const history = useApi(`/me/gets?page=${page}&pageSize=15`)
  const rows = history.data?.data ?? []
  return (
          <section className="dg-history glass" aria-label="Histórico de Gets">
            {history.error ? <LoadError message={history.error} onRetry={history.reload} />
              : history.loading && !history.data ? <Skeleton lines={5} />
                : rows.length === 0 ? (
                  <div className="dg-history-empty">
                    <Gavel size={26} weight="duotone" aria-hidden="true" />
                    <div>
                      <p className="dw-empty-title">Nenhum Get por aqui ainda</p>
                      <p className="dw-empty-copy">Escolha uma Vibe aberta para entrar na disputa.</p>
                    </div>
                    <Link className="btn btn-glass" to="/vibes">Explorar Vibes<ArrowUpRight size={17} aria-hidden="true" /></Link>
                  </div>
                ) : (
                  <div className="dg-table-wrap">
                    <table className="dg-table">
                      <thead>
                        <tr>
                          <th scope="col">Vibe</th>
                          <th scope="col">Data</th>
                          <th scope="col" className="num">R$</th>
                          <th scope="col" className="num">GetCoin</th>
                          <th scope="col" className="num">Na disputa</th>
                          <th scope="col">Situação</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((g) => {
                          const [label, tone] = GET_STATUS[g.status] ?? [g.status, 'off']
                          const vibeStatus = g.vibeStatus ?? g.vibe?.status
                          const createdAt = dateFmt.format(new Date(g.createdAt))
                          return (
                            <tr key={g.id}>
                              <th scope="row">
                                <span className="dg-product">{g.product?.name ?? '—'}</span>
                                <span className="dg-vibe-status">{VIBE_STATUS[vibeStatus] ?? ''}</span>
                                <span className="mono dg-mobile-date">{createdAt}</span>
                              </th>
                              <td className="mono dg-date">{createdAt}</td>
                              <td className="mono num">{brl(g.cashCents)}</td>
                              <td className="mono num">{g.getcoinCents ? coins(g.getcoinCents) : '—'}</td>
                              <td className="mono num dg-total">{brl(g.totalCents)}</td>
                              <td>
                                {g.isChampion
                                  ? <span className="dg-pill dg-pill-lead">Champion Get</span>
                                  : <span className={`dg-pill dg-pill-${tone}`}>{label}</span>}
                                {g.isLeading && <span className="dg-pill dg-pill-lead">Liderando</span>}
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
            {rows.length > 0 ? <Pager meta={history.data?.meta} onPage={setPage} /> : null}
          </section>
  )
}

const TABS = [['disputa', 'Em disputa'], ['premios', 'Prêmios'], ['favoritas', 'Favoritas'], ['historico', 'Histórico']]

export default function Gets() {
  const [params, setParams] = useSearchParams()
  const tabRefs = useRef(new Map())
  const tab = TABS.some(([id]) => id === params.get('aba')) ? params.get('aba') : 'disputa'
  const summaryRes = useApi('/me/gets/summary')
  const prizes = useApi('/me/prizes')
  const now = useNow()
  const s = summaryRes.data?.data ?? summaryRes.data
  const awaiting = (prizes.data?.data ?? []).filter((p) => p.status === 'AWAITING_ADDRESS').length

  const selectTab = (id) => setParams(id === 'disputa' ? {} : { aba: id }, { replace: true })
  const onTabKeyDown = (event, index) => {
    const keys = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: TABS.length - 1 }
    if (!(event.key in keys)) return
    event.preventDefault()
    const id = TABS[(keys[event.key] + TABS.length) % TABS.length][0]
    selectTab(id)
    tabRefs.current.get(id)?.focus()
  }

  return (
    <div className="dp">
      <PageHead title="Meus Gets">
        <div className="auth-tabs dg-tabs" role="tablist" aria-label="Meus Gets">
          {TABS.map(([id, label], index) => (
            <button
              key={id} id={`dg-tab-${id}`} type="button" role="tab" aria-selected={tab === id} aria-controls={`dg-panel-${id}`}
              tabIndex={tab === id ? 0 : -1} className="auth-tab"
              ref={(node) => (node ? tabRefs.current.set(id, node) : tabRefs.current.delete(id))}
              onClick={() => selectTab(id)} onKeyDown={(event) => onTabKeyDown(event, index)}
            >
              {tab === id && <motion.span layoutId="dg-tab-pill" className="auth-tab-pill" transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }} />}
              <span className="auth-tab-label">
                {label}
                {id === 'premios' && awaiting > 0 && <span className="dg-tab-dot" aria-label={`${awaiting} aguardando endereço`} />}
              </span>
            </button>
          ))}
        </div>
      </PageHead>

      {summaryRes.error ? <LoadError message={summaryRes.error} onRetry={summaryRes.reload} />
        : summaryRes.loading && !summaryRes.data ? (
          <section className="dg-stats-loading glass" aria-label="Carregando resumo dos Gets"><Skeleton lines={2} /></section>
        ) : (
          <dl className="dg-stats glass">
            <div className="dg-stat"><dt>Participadas</dt><dd className="mono">{s ? s.participated : '—'}</dd><p>Vibes com pelo menos um Get</p></div>
            <div className="dg-stat"><dt>Ativas</dt><dd className="mono">{s ? s.active : '—'}</dd><p>Seus Gets em disputas ao vivo</p></div>
            <div className="dg-stat"><dt>Vencidas</dt><dd className="mono">{s ? s.won : '—'}</dd><p>Champion Gets conquistados</p></div>
          </dl>
        )}

      <div id={`dg-panel-${tab}`} role="tabpanel" aria-labelledby={`dg-tab-${tab}`} className="dg-panel">
        {tab === 'disputa' && <DisputeTab now={now} summary={s} />}
        {tab === 'premios' && <PrizesSection prizes={prizes} />}
        {tab === 'favoritas' && <FavoritesSection now={now} />}
        {tab === 'historico' && <HistoryTab />}
      </div>
    </div>
  )
}
