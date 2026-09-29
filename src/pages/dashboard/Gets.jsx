import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
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
    <section className="dg-section" aria-labelledby="dg-fav-title">
      <h2 id="dg-fav-title" className="dh-section-title">
        <Heart size={20} weight="fill" className="dg-heart" aria-hidden="true" />
        Vibes favoritas {list.length ? <span className="mono dg-count dg-count-soft">{list.length}</span> : null}
      </h2>
      {fav.error ? <LoadError message={fav.error} onRetry={fav.reload} />
        : fav.loading && !fav.data ? <Skeleton lines={2} />
          : list.length === 0 ? (
            <div className="dg-inline-empty">
              <p className="dg-inline-empty-title">Nenhuma favorita ainda</p>
              <p>Toque no coração na página de uma Vibe para guardá-la aqui.</p>
            </div>
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

export default function Gets() {
  const [page, setPage] = useState(1)
  const summary = useApi('/me/gets/summary')
  const leading = useApi('/me/gets/leading')
  const history = useApi(`/me/gets?page=${page}&pageSize=15`)
  const now = useNow()
  const s = summary.data?.data ?? summary.data
  const leadList = leading.data?.data ?? []
  const rows = history.data?.data ?? []
  const firstGet = Boolean(
    s && s.participated === 0 && leading.data && history.data
    && !leading.error && !history.error && leadList.length === 0 && rows.length === 0,
  )

  return (
    <div className="dp">
      <PageHead title="Meus Gets" />

      {summary.error ? <LoadError message={summary.error} onRetry={summary.reload} />
        : summary.loading && !summary.data ? (
          <section className="dg-stats-loading glass" aria-label="Carregando resumo dos Gets"><Skeleton lines={2} /></section>
        ) : (
          <dl className="dg-stats glass">
            <div className="dg-stat"><dt>Participadas</dt><dd className="mono">{s ? s.participated : '—'}</dd><p>Vibes com pelo menos um Get</p></div>
            <div className="dg-stat"><dt>Ativas</dt><dd className="mono">{s ? s.active : '—'}</dd><p>Seus Gets em disputas ao vivo</p></div>
            <div className="dg-stat"><dt>Vencidas</dt><dd className="mono">{s ? s.won : '—'}</dd><p>Champion Gets conquistados</p></div>
          </dl>
        )}

      <PrizesSection />

      {firstGet ? (
        <section className="dg-onboarding glass" aria-labelledby="dg-first-title">
          <Gavel size={34} weight="duotone" aria-hidden="true" />
          <div className="dg-onboarding-copy">
            <h2 id="dg-first-title" className="dh-section-title">Seu primeiro Get começa em uma Vibe aberta</h2>
            <p className="dh-text">Escolha um produto, defina o valor do seu Get e entre na disputa. Depois, todo o acompanhamento aparece aqui.</p>
          </div>
          <Link className="btn btn-coin" to="/vibes">Explorar Vibes<ArrowRight size={18} weight="bold" aria-hidden="true" /></Link>
        </section>
      ) : (
        <>
          <section className="dg-section" aria-labelledby="dg-lead-title">
            <h2 id="dg-lead-title" className="dh-section-title">
              <Trophy size={20} weight="fill" className="dg-trophy" aria-hidden="true" />
              Você está vencendo {s ? <span className="mono dg-count">{s.leading}</span> : null}
            </h2>
            {leading.error ? <LoadError message={leading.error} onRetry={leading.reload} />
              : leading.loading && !leading.data ? <Skeleton lines={2} />
                : leadList.length === 0 ? (
                  <div className="dg-inline-empty">
                    <p className="dg-inline-empty-title">Nenhuma liderança agora</p>
                    <p>Quando o seu Get for o maior de uma Vibe ao vivo, ela aparece aqui.</p>
                  </div>
                ) : (
                  <ul className="dg-leads">{leadList.map((item) => <LeadingCard key={item.vibe.id} item={item} now={now} />)}</ul>
                )}
          </section>

          <FavoritesSection now={now} />

          <section className="dg-history glass" aria-labelledby="dg-hist-title">
            <h2 id="dg-hist-title" className="dh-section-title">Histórico de Gets</h2>
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
        </>
      )}
    </div>
  )
}
