import { useEffect, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { ArrowRight, Check, Copy, EnvelopeSimple, IdentificationCard, LockSimple, Trophy, WarningCircle } from '@phosphor-icons/react'
import { api, brl, coins } from '../../lib/api.js'
import { useApi } from '../../lib/useApi.js'
import { useAuth } from '../../lib/auth.jsx'
import { Coin, LEVELS, LoadError, Skeleton, dateFmt } from './ui.jsx'

export const MOVEMENT = {
  WELCOME_BONUS: 'Bônus de boas-vindas',
  CASHBACK: 'GetCoin de volta',
  SPEND_ON_GET: 'Usado em um Get',
  REFUND: 'Devolução',
  REFERRAL: 'Bônus de indicação',
  ADJUSTMENT: 'Ajuste da equipe',
  COUPON: 'Cupom',
  PURCHASE: 'Compra de GetCoins',
  PURCHASE_BONUS: 'Bônus da compra',
  MARKET_ESCROW: 'Anunciado no marketplace',
  MARKET_ESCROW_RETURN: 'Devolvido do marketplace',
  MARKET_BUY: 'Compra no marketplace',
}

export function CopyButton({ value, label, done = 'Copiado' }) {
  const [copied, setCopied] = useState(false)
  async function copy() {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {
      setCopied(false)
    }
  }
  return (
    <button type="button" className="btn btn-glass btn-sm" onClick={copy} aria-live="polite">
      {copied ? <Check size={16} weight="bold" aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
      {copied ? done : label}
    </button>
  )
}

function ResendVerification() {
  const [state, setState] = useState('idle')
  const [message, setMessage] = useState('')
  async function resend() {
    setState('busy')
    try {
      await api('/auth/resend-verification', { method: 'POST' })
      setState('sent')
    } catch (err) {
      setMessage(err.message)
      setState('error')
    }
  }
  if (state === 'sent') return <p className="dash-note-ok" role="status">Enviamos um novo link. Confira a caixa de entrada e o spam.</p>
  return (
    <>
      <button type="button" className="btn btn-glass btn-sm" onClick={resend} disabled={state === 'busy'}>Reenviar e-mail</button>
      {state === 'error' && <p className="af-error" role="alert"><WarningCircle size={16} weight="fill" aria-hidden="true" />{message}</p>}
    </>
  )
}

export function MovementList({ items }) {
  return (
    <ul className="dash-moves">
      {items.map((m) => (
        <li key={m.id}>
          <span className="dash-move-type">{MOVEMENT[m.type] ?? m.type}</span>
          <time className="dash-move-date mono" dateTime={m.createdAt}>{dateFmt.format(new Date(m.createdAt))}</time>
          <span className={`dash-move-amount mono ${m.amountCents >= 0 ? 'is-in' : ''}`}>
            {m.amountCents >= 0 ? '+' : '−'}{coins(Math.abs(m.amountCents))}
          </span>
        </li>
      ))}
    </ul>
  )
}

function LevelCard({ number, name, state, emblem }) {
  const status = state === 'current' ? 'Ativo' : state === 'complete' ? 'Concluído' : 'Bloqueado'
  return (
    <article className={`dh-level-card is-${state}`} aria-label={`Nível ${number}, ${name}, ${status}`}>
      <div className="dh-level-card-top">
        <strong>VibeGet</strong>
        <span className="dh-level-status">
          {state === 'locked'
            ? <LockSimple size={14} aria-hidden="true" />
            : <Check size={14} weight="bold" aria-hidden="true" />}
          {status}
        </span>
      </div>
      <span className="dh-level-chip" aria-hidden="true" />
      <div className="dh-level-card-bottom">
        <div>
          <p className="mono">Nível {number}</p>
          <h2>{name}</h2>
        </div>
        <span className="dh-level-emblem" aria-hidden="true">
          {emblem === 'coin' ? <Coin /> : <Trophy size={27} weight="duotone" />}
        </span>
      </div>
    </article>
  )
}

function LevelJourney({ currentLevel }) {
  const reachedViber = currentLevel >= 2
  return (
    <section className="dh-level-journey" aria-label="Progressão de nível">
      <LevelCard number={1} name="Explorador" state={reachedViber ? 'complete' : 'current'} emblem="coin" />
      <div className={`dh-level-gate ${reachedViber ? 'is-complete' : ''}`} aria-label={reachedViber ? 'Marco concluído: primeiro Champion Get' : 'Próximo marco: primeiro Champion Get'}>
        <span className="dh-level-gate-line" aria-hidden="true" />
        <p><Trophy size={16} weight="fill" aria-hidden="true" /><span>1º Champion Get</span></p>
        <ArrowRight size={22} weight="bold" aria-hidden="true" />
      </div>
      <LevelCard number={2} name="Viber" state={reachedViber ? 'current' : 'locked'} emblem="trophy" />
    </section>
  )
}

export default function Home() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  // O aviso de boas-vindas vale só para a chegada; limpa o estado para não repetir ao recarregar.
  const [arrival] = useState(location.state)
  useEffect(() => {
    if (location.state) navigate(location.pathname, { replace: true, state: null })
  }, [location.state, location.pathname, navigate])

  const dash = useApi('/me/dashboard')
  const leading = useApi('/me/gets/leading')
  const d = dash.data?.data
  const me = d?.user ?? user
  const level = LEVELS[d?.level ?? me?.level] ?? LEVELS.EXPLORADOR
  const firstName = me?.name?.split(' ')[0] ?? ''
  const summary = d?.getsSummary
  const referralCode = d?.referralCode ?? me?.referralCode
  const referralLink = referralCode ? `${window.location.origin}/cadastro?ref=${referralCode}` : ''
  const leadingList = leading.data?.data ?? []

  return (
    <div className="dp">
      <header className="dp-head">
        <h1 className="dp-title">{arrival?.welcome ? `Conta criada, ${firstName}.` : `Olá, ${firstName}.`}</h1>
      </header>

      {arrival?.couponApplied === false && (
        <div className="af-alert af-alert-error" role="status">
          <WarningCircle size={20} weight="fill" aria-hidden="true" />
          <div>O cupom informado no cadastro não pôde ser aplicado. Sua conta foi criada normalmente.</div>
        </div>
      )}
      {dash.error && <LoadError message={dash.error} onRetry={dash.reload} />}

      {d?.prizesAwaitingAddress > 0 && (
        <section className="pz-banner glass" aria-labelledby="pz-banner-title">
          <Trophy size={30} weight="fill" className="pz-banner-icon" aria-hidden="true" />
          <div>
            <h2 id="pz-banner-title" className="dh-section-title">
              {d.prizesAwaitingAddress > 1 ? `Você tem ${d.prizesAwaitingAddress} prêmios esperando` : 'Você venceu uma Vibe!'}
            </h2>
            <p className="dh-text">Confirme o endereço de entrega para a gente enviar o seu prêmio.</p>
          </div>
          <Link to="/dashboard/gets#premios" className="btn btn-coin">Confirmar endereço<ArrowRight size={18} weight="bold" aria-hidden="true" /></Link>
        </section>
      )}

      <div className="dh-grid">
        <section className="dh-wallet glass" aria-label="Carteira">
          <div className="dh-row">
            <div className="dh-figure">
              <h2 className="dash-label">Saldo em carteira</h2>
              <p className="dh-amount mono">{d ? brl(d.cashBalanceCents ?? 0) : '—'}</p>
            </div>
            <Link to="/dashboard/carteira?aba=saldo" className="btn btn-glass">Sacar</Link>
          </div>
          <div className="dh-row">
            <div className="dh-figure">
              <h2 className="dash-label">GetCoins</h2>
              <p className="dh-amount dh-amount-coin"><Coin /><span className="mono">{d ? coins(d.balanceCents) : '—'}</span></p>
            </div>
            <Link to="/dashboard/comprar" className="btn btn-coin">Comprar GetCoins<ArrowRight size={18} weight="bold" aria-hidden="true" /></Link>
          </div>
          <p className="dh-foot">
            <span>GetCoin de volta até agora</span>
            <span className="mono">{d ? coins(d.cashbackReceivedCents) : '—'}</span>
          </p>
        </section>

        <div className="dh-side glass">
          <section className="dh-panel" aria-labelledby="dh-ref-title">
            <div className="dh-panel-line">
              <h2 id="dh-ref-title" className="dash-label">Código de indicação</h2>
              <p className="dh-code mono">{referralCode ?? '—'}</p>
            </div>
            <p className="dh-text">Compartilhe seu link para convidar amigos para as Vibes.</p>
            {referralCode && (
              <div className="dh-actions">
                <CopyButton value={referralCode} label="Copiar código" />
                <CopyButton value={referralLink} label="Copiar link" />
              </div>
            )}
          </section>
        </div>
      </div>

      <LevelJourney currentLevel={level.n} />

      <section className="dh-block glass" aria-labelledby="dh-gets-title">
        <div className="dh-block-head">
          <h2 id="dh-gets-title" className="dh-section-title">Meus Gets</h2>
          <Link to="/dashboard/gets" className="text-link">Ver todos<ArrowRight size={16} aria-hidden="true" /></Link>
        </div>
        <dl className="dh-counts">
          <div><dt>Participadas</dt><dd className="mono">{summary ? summary.participated : '—'}</dd></div>
          <div><dt>Ativas</dt><dd className="mono">{summary ? summary.active : '—'}</dd></div>
          <div><dt>Vencendo agora</dt><dd className="mono">{summary ? summary.leading : '—'}</dd></div>
          <div><dt>Vencidas</dt><dd className="mono">{summary ? summary.won : '—'}</dd></div>
        </dl>
        {leadingList.length > 0 && (
          <ul className="dh-leading">
            {leadingList.slice(0, 3).map((v) => (
              <li key={v.vibe.id}>
                <Trophy size={18} weight="fill" className="dh-leading-icon" aria-hidden="true" />
                <span className="dh-leading-name">{v.product.name}</span>
                <span className="dh-leading-get mono">{brl(v.myTopGet.totalCents)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {me && (!me.emailVerified || !me.hasCpf) && (
        <section className="dh-block glass" aria-label="Próximos passos">
          <ul className="dash-steps">
            {!me.emailVerified && (
              <li className="dash-task">
                <EnvelopeSimple size={24} className="dash-task-icon" aria-hidden="true" />
                <div className="dash-task-body">
                  <h2>Confirme seu e-mail</h2>
                  <p>Enviamos um link para <b>{me.email.split('@')[0]}<wbr />@{me.email.split('@')[1]}</b>. A confirmação é necessária para dar Gets.</p>
                  <ResendVerification />
                </div>
              </li>
            )}
            {!me.hasCpf && (
              <li className="dash-task">
                <IdentificationCard size={24} className="dash-task-icon" aria-hidden="true" />
                <div className="dash-task-body">
                  <h2>Complete seus dados</h2>
                  <p>CPF, celular e data de nascimento são necessários antes do primeiro Get. A participação é só para maiores de 18 anos.</p>
                  <Link to="/dashboard/conta" className="btn btn-glass btn-sm">Completar agora</Link>
                </div>
              </li>
            )}
          </ul>
        </section>
      )}

      <section className="dh-block glass" aria-labelledby="dh-moves-title">
        <div className="dh-block-head">
          <h2 id="dh-moves-title" className="dh-section-title">Últimas movimentações de GetCoin</h2>
          <Link to="/dashboard/carteira" className="text-link">Ver extrato<ArrowRight size={16} aria-hidden="true" /></Link>
        </div>
        {!d ? (
          dash.loading ? <Skeleton lines={3} /> : null
        ) : d.recentMovements.length === 0 ? (
          <p className="dash-empty">Nenhuma movimentação ainda. Seu GetCoin aparece aqui quando você der o primeiro Get ou comprar GetCoins.</p>
        ) : (
          <MovementList items={d.recentMovements.slice(0, 5)} />
        )}
      </section>
    </div>
  )
}
