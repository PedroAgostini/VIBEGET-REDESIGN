import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion, MotionConfig } from 'framer-motion'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import {
  ArrowLeft, ArrowRight, CalendarBlank, CaretLeft, CaretRight, Check, CircleNotch, Coins, CreditCard, Eye, Gavel,
  Gift, Heart, Package, PixLogo, SealCheck, ShareNetwork, ShieldCheck, Timer, Trophy, Truck, Wallet, WarningCircle,
} from '@phosphor-icons/react'
import { api, ApiError, brl, coins, newIdempotencyKey, publicPost } from '../lib/api.js'
import { useAuth } from '../lib/auth.jsx'
import { Footer, Nav, countdown, useNow } from '../App.jsx'
import Coin from '../components/Coin.jsx'
import { CAT_LABEL } from '../components/VibeCard.jsx'
import FeaturedVibes from '../components/FeaturedVibes.jsx'

const ease = [0.16, 1, 0.3, 1]

/** Benefícios fixos da plataforma (PRODUCT.md); os extras de cada Vibe vêm do dashboard. */
const FIXED_BENEFITS = [
  { Icon: SealCheck, title: 'Novo e lacrado', text: 'Produto original, na caixa, nunca usado.' },
  { Icon: ShieldCheck, title: 'Garantia de fábrica', text: 'A mesma garantia de uma compra na loja.' },
  { Icon: Truck, title: 'Envio com rastreio', text: 'Entrega para todo o Brasil com código de rastreio.' },
]

const rtf = new Intl.RelativeTimeFormat('pt-BR', { numeric: 'auto' })
function timeAgo(date, now) {
  const s = Math.round((new Date(date).getTime() - now) / 1000)
  const abs = Math.abs(s)
  if (abs < 60) return rtf.format(s, 'second')
  if (abs < 3600) return rtf.format(Math.round(s / 60), 'minute')
  if (abs < 86400) return rtf.format(Math.round(s / 3600), 'hour')
  return rtf.format(Math.round(s / 86400), 'day')
}

/** "1.234,56" → 123456 centavos. */
const parseBrl = (v) => {
  const d = String(v).replace(/\D/g, '')
  return d ? parseInt(d, 10) : 0
}
const maskBrl = (cents) => (cents ? (cents / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 }) : '')

/* ---------------- Galeria ---------------- */

/** Foto principal com voltar/avançar (setas, teclado e arrastar no celular) e a faixa de fotos embaixo. */
function Gallery({ images, name }) {
  const [i, setI] = useState(0)
  const [dir, setDir] = useState(1)
  const startX = useRef(null)
  const thumbsRef = useRef(null)
  const n = images.length
  const many = n > 1
  const go = (d) => {
    if (!many) return
    setDir(d)
    setI((x) => (x + d + n) % n)
  }
  const pick = (k) => {
    setDir(k > i ? 1 : -1)
    setI(k)
  }

  // A miniatura ativa fica sempre visível na faixa.
  useEffect(() => {
    thumbsRef.current?.children[i]?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' })
  }, [i])

  if (n === 0) {
    return (
      <div className="vd-gallery">
        <div className="vd-stage plate is-loaded is-empty"><Package size={72} weight="duotone" className="vibe-noimg" aria-hidden="true" /></div>
      </div>
    )
  }
  return (
    <div className="vd-gallery">
      <div
        className="vd-stage plate is-loaded"
        role="group"
        aria-roledescription="galeria"
        aria-label={`Fotos de ${name}, ${i + 1} de ${n}`}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight') go(1)
          if (e.key === 'ArrowLeft') go(-1)
        }}
        onPointerDown={(e) => { startX.current = e.clientX }}
        onPointerUp={(e) => {
          if (startX.current == null) return
          const dx = e.clientX - startX.current
          startX.current = null
          if (Math.abs(dx) > 40) go(dx < 0 ? 1 : -1)
        }}
      >
        <AnimatePresence mode="popLayout" initial={false} custom={dir}>
          <motion.img
            key={images[i]}
            src={images[i]}
            alt={i === 0 ? name : `${name}, foto ${i + 1}`}
            draggable={false}
            custom={dir}
            initial={(d) => ({ opacity: 0, x: d * 40 })}
            animate={{ opacity: 1, x: 0 }}
            exit={(d) => ({ opacity: 0, x: d * -40 })}
            transition={{ duration: 0.35, ease }}
          />
        </AnimatePresence>
        <button type="button" className="vd-arrow is-prev" onClick={() => go(-1)} disabled={!many} aria-label="Foto anterior"><CaretLeft size={20} weight="bold" /></button>
        <button type="button" className="vd-arrow is-next" onClick={() => go(1)} disabled={!many} aria-label="Próxima foto"><CaretRight size={20} weight="bold" /></button>
        <span className="vd-counter mono" aria-hidden="true">{i + 1} / {n}</span>
      </div>
      <div className="vd-thumbs" ref={thumbsRef}>
        {images.map((src, k) => (
          <button key={src} type="button" className={`vd-thumb plate is-loaded ${k === i ? 'is-on' : ''}`} onClick={() => pick(k)} aria-label={`Ver foto ${k + 1} de ${n}`} aria-current={k === i ? 'true' : undefined}>
            <img src={src} alt="" loading="lazy" draggable={false} />
          </button>
        ))}
      </div>
    </div>
  )
}

/* ---------------- Pagamento pendente ---------------- */

function CopyText({ value }) {
  const [ok, setOk] = useState(false)
  return (
    <button
      type="button"
      className="btn btn-glass btn-sm"
      onClick={async () => {
        try { await navigator.clipboard.writeText(value); setOk(true); setTimeout(() => setOk(false), 1800) } catch { /* sem permissão */ }
      }}
    >
      {ok ? <><Check size={16} weight="bold" aria-hidden="true" />Copiado</> : 'Copiar código Pix'}
    </button>
  )
}

function PaymentWatch({ result, onDone }) {
  const [state, setState] = useState(result)
  const [simulating, setSimulating] = useState(false)
  const status = state.get.status
  const payment = state.payment ?? {}

  useEffect(() => {
    if (status !== 'PENDING_PAYMENT') {
      onDone(state)
      return
    }
    const id = setInterval(async () => {
      try {
        const res = await api(`/me/gets/${state.get.id}`)
        setState(res.data)
      } catch { /* tenta de novo */ }
    }, 3000)
    return () => clearInterval(id)
  }, [status]) // eslint-disable-line react-hooks/exhaustive-deps

  async function simulate() {
    setSimulating(true)
    try {
      await api(`/payments/${payment.id}/simulate`, { method: 'POST', body: { status: 'PAID' } })
      setState((await api(`/me/gets/${state.get.id}`)).data)
    } finally {
      setSimulating(false)
    }
  }

  if (status !== 'PENDING_PAYMENT') return null
  return (
    <div className="db-pix vd-pix" aria-live="polite">
      <p className="db-pix-wait"><CircleNotch size={18} className="af-spin" aria-hidden="true" />Aguardando o pagamento de <b className="mono">{brl(state.get.cashCents)}</b></p>
      {payment.pixCopyPaste ? (
        <>
          <p className="dh-text">Copie o código Pix e pague no app do seu banco. Seu Get entra na disputa assim que o pagamento for confirmado.</p>
          <code className="db-pix-code mono">{payment.pixCopyPaste}</code>
          <CopyText value={payment.pixCopyPaste} />
        </>
      ) : (
        <p className="dh-text">Conclua o pagamento no cartão. Esta tela atualiza sozinha quando ele for confirmado.</p>
      )}
      {import.meta.env.DEV && payment.id && (
        <button type="button" className="btn btn-glass btn-sm" onClick={simulate} disabled={simulating}>Simular pagamento (só em desenvolvimento)</button>
      )}
    </div>
  )
}

/* ---------------- Painel de Get ---------------- */

const ELIGIBILITY = {
  EMAIL_NOT_VERIFIED: 'Confirme seu e-mail para dar Gets. O link está na sua caixa de entrada.',
  CPF_REQUIRED: 'Informe seu CPF em Minha conta para dar Gets.',
  BIRTHDATE_REQUIRED: 'Informe sua data de nascimento em Minha conta para dar Gets.',
}

function GetPanel({ vibe, now, onPlaced }) {
  const { status: authStatus, user } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const authed = authStatus === 'authed'
  const top = vibe.topGet?.totalCents ?? 0
  const min = vibe.minGetCents
  const suggested = Math.max(min, top ? top + 100 : min)

  const [cash, setCash] = useState(suggested)
  const [turbo, setTurbo] = useState(false)
  const [gc, setGc] = useState(0)
  const [method, setMethod] = useState('PIX')
  const [balances, setBalances] = useState({ getcoin: 0, cash: 0 })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [pending, setPending] = useState(null)
  const [placed, setPlaced] = useState(null)
  const key = useRef(newIdempotencyKey())

  const loadBalances = useCallback(async () => {
    if (!authed) return
    try {
      const [w, c] = await Promise.all([api('/me/wallet?pageSize=1'), api('/me/cash?pageSize=1')])
      setBalances({ getcoin: w.balanceCents ?? 0, cash: c.data?.balanceCents ?? 0 })
    } catch { /* os saldos são só informativos aqui */ }
  }, [authed])
  useEffect(() => { loadBalances() }, [loadBalances])

  // Uma nova combinação é uma nova operação: troca a chave de idempotência.
  useEffect(() => { key.current = newIdempotencyKey() }, [cash, gc, turbo, method])

  const maxGc = Math.min(cash, balances.getcoin)
  const usedGc = turbo ? Math.min(gc, maxGc) : 0
  const total = cash + usedGc
  const back = Math.floor((cash * (vibe.cashbackPercent ?? 40)) / 100)
  const closeAt = new Date(vibe.getsCloseAt ?? vibe.endsAt).getTime()
  const open = vibe.status === 'LIVE' && now < closeAt
  const missing = authed && user ? (!user.emailVerified ? 'EMAIL_NOT_VERIFIED' : !user.hasCpf ? 'CPF_REQUIRED' : !user.birthDate ? 'BIRTHDATE_REQUIRED' : null) : null
  const belowMin = total < min
  const cashShort = method === 'BALANCE' && cash > balances.cash

  useEffect(() => { if (turbo) setGc((g) => (g ? Math.min(g, maxGc) : maxGc)) }, [turbo, maxGc])

  async function submit(e) {
    e.preventDefault()
    setError(null)
    if (!authed) {
      navigate(`/login?next=${encodeURIComponent(location.pathname)}`)
      return
    }
    if (missing || belowMin || cashShort || !open) return
    setBusy(true)
    try {
      const res = await api(`/vibes/${vibe.id}/gets`, {
        method: 'POST',
        body: { cashCents: cash, getcoinCents: usedGc, method },
        headers: { 'Idempotency-Key': key.current },
      })
      key.current = newIdempotencyKey()
      if (res.data.get.status === 'CONFIRMED') finish(res.data)
      else setPending(res.data)
    } catch (err) {
      setError(err instanceof ApiError ? (ELIGIBILITY[err.code] ?? err.message) : 'Algo deu errado. Tente de novo.')
    } finally {
      setBusy(false)
    }
  }

  function finish(result) {
    setPending(null)
    loadBalances()
    if (result.get.status === 'CONFIRMED') {
      setPlaced(result.get)
      onPlaced()
    } else {
      setError('O pagamento não foi concluído. Nenhum valor foi cobrado e o GetCoin usado voltou para a sua carteira.')
    }
  }

  if (vibe.status === 'ENDED') {
    return (
      <div className="vd-panel glass">
        <p className="vd-panel-state"><Trophy size={20} weight="fill" className="vibe-champ" aria-hidden="true" />Vibe encerrada</p>
        {vibe.winner ? (
          <p className="dh-text">Champion Get de <b className="mono">{brl(vibe.winner.totalCents)}</b> por {vibe.winner.by}. Quem não venceu recebeu {vibe.cashbackPercent}% do valor pago de volta em GetCoin.</p>
        ) : (
          <p className="dh-text">Esta Vibe terminou sem Gets confirmados.</p>
        )}
        <Link to="/vibes" className="btn btn-coin btn-block">Ver Vibes ao vivo<ArrowRight size={18} weight="bold" /></Link>
      </div>
    )
  }
  if (vibe.status === 'SCHEDULED') {
    return (
      <div className="vd-panel glass">
        <p className="vd-panel-state"><CalendarBlank size={20} aria-hidden="true" />Abre em <span className="mono">{countdown(new Date(vibe.startsAt).getTime() - now)}</span></p>
        <p className="dh-text">Get mínimo de <b className="mono">{brl(min)}</b>. Favorite para encontrar esta Vibe rápido quando abrir.</p>
      </div>
    )
  }

  return (
    <form className="vd-panel glass" onSubmit={submit} noValidate aria-label="Dar Get" id="dar-get">
      <AnimatePresence>
        {placed && (
          <motion.div className="af-alert af-alert-ok" role="status" initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
            <Check size={20} weight="bold" aria-hidden="true" />
            <div>Get de <b className="mono">{brl(placed.totalCents)}</b> na disputa. Acompanhe em <Link to="/dashboard/gets" className="af-inline-link">Meus Gets</Link>.</div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="vd-field">
        <div className="vd-field-head">
          <label htmlFor="vd-cash">Seu Get em R$</label>
          <span className="muted small">Mínimo <span className="mono">{brl(min)}</span></span>
        </div>
        <div className="vd-money">
          <span className="vd-money-prefix mono" aria-hidden="true">R$</span>
          <input
            id="vd-cash"
            className="mono"
            inputMode="numeric"
            value={maskBrl(cash)}
            onChange={(e) => setCash(Math.min(parseBrl(e.target.value), 100_000_00))}
            aria-describedby="vd-cash-hint"
          />
        </div>
        <div className="vd-quick" id="vd-cash-hint">
          <button type="button" className="vd-quick-btn" onClick={() => setCash(min)}>Mínimo</button>
          {top > 0 && <button type="button" className="vd-quick-btn" onClick={() => setCash(Math.max(min, top + 100 - usedGc))}>Passar o maior Get</button>}
          <button type="button" className="vd-quick-btn" onClick={() => setCash((c) => c + 500)}>+ R$ 5</button>
        </div>
      </div>

      <div className={`vd-turbo ${turbo ? 'is-on' : ''}`}>
        <label className="vd-turbo-head">
          <span className="vd-turbo-title"><Coin size={22} />Turbinar com GetCoin</span>
          <input type="checkbox" className="vd-switch-input" checked={turbo} onChange={(e) => setTurbo(e.target.checked)} disabled={!authed || balances.getcoin <= 0} />
          <span className="vd-switch" aria-hidden="true" />
        </label>
        <p className="muted small">
          {!authed ? 'Entre para usar seu saldo de GetCoin.' : balances.getcoin > 0 ? <>Saldo <span className="mono">{coins(balances.getcoin)}</span>. Até o mesmo valor do Get em dinheiro.</> : 'Você ainda não tem GetCoin.'}
        </p>
        {turbo && maxGc > 0 && (
          <input
            type="range" className="vd-range" min={0} max={maxGc} step={1} value={usedGc}
            onChange={(e) => setGc(Number(e.target.value))}
            aria-label="GetCoin usado" aria-valuetext={`${coins(usedGc)} GetCoin`}
            style={{ '--p': `${maxGc ? (usedGc / maxGc) * 100 : 0}%` }}
          />
        )}
      </div>

      <dl className="vd-ledger">
        <div><dt>Em dinheiro</dt><dd className="mono">{brl(cash)}</dd></div>
        {usedGc > 0 && <div><dt>GetCoin</dt><dd className="mono coin-ink">+ {coins(usedGc)}</dd></div>}
        <div className="vd-ledger-total"><dt>Total na disputa</dt><dd className="mono">{brl(total)}</dd></div>
      </dl>
      <p className="vd-back"><Coins size={18} aria-hidden="true" />Se não vencer, <b className="mono">{coins(back)}</b> voltam em GetCoin.</p>

      <fieldset className="vd-methods">
        <legend className="sr-only">Forma de pagamento</legend>
        {[['PIX', 'Pix', PixLogo], ['CARD', 'Cartão', CreditCard], ['BALANCE', 'Saldo', Wallet]].map(([id, label, Icon]) => (
          <label key={id} className={`db-method ${method === id ? 'is-selected' : ''}`}>
            <input type="radio" name="vd-method" value={id} checked={method === id} onChange={() => setMethod(id)} />
            <Icon size={18} aria-hidden="true" /><span>{label}</span>
          </label>
        ))}
      </fieldset>

      {missing && (
        <div className="af-alert af-alert-error">
          <WarningCircle size={20} weight="fill" aria-hidden="true" />
          <div>{ELIGIBILITY[missing]} {missing !== 'EMAIL_NOT_VERIFIED' && <Link to="/dashboard/conta" className="af-inline-link">Completar agora</Link>}</div>
        </div>
      )}
      {belowMin && <p className="af-error"><WarningCircle size={16} weight="fill" aria-hidden="true" />O total precisa ser de pelo menos {brl(min)}.</p>}
      {cashShort && <p className="af-error"><WarningCircle size={16} weight="fill" aria-hidden="true" />Seu saldo em carteira é {brl(balances.cash)}. Escolha Pix ou cartão.</p>}
      {error && <div className="af-alert af-alert-error" role="alert"><WarningCircle size={20} weight="fill" aria-hidden="true" /><div>{error}</div></div>}

      {pending ? (
        <PaymentWatch key={pending.get.id} result={pending} onDone={finish} />
      ) : !open ? (
        <p className="vd-panel-state"><Timer size={18} aria-hidden="true" />Gets encerrados. O resultado sai em instantes.</p>
      ) : (
        <button type="submit" className="btn btn-coin btn-lg btn-block" disabled={busy || (authed && (Boolean(missing) || belowMin || cashShort))}>
          {busy ? <><CircleNotch size={20} className="af-spin" aria-hidden="true" />Enviando…</> : authed ? <>Dar Get de <span className="mono">{brl(total)}</span><ArrowRight size={18} weight="bold" /></> : <>Entrar para dar Get<ArrowRight size={18} weight="bold" /></>}
        </button>
      )}
    </form>
  )
}

/* ---------------- Página ---------------- */

function Shell({ children }) {
  return (
    <MotionConfig reducedMotion="user">
      <a className="skip-link" href="#main">Pular para o conteúdo</a>
      <div className="atmos" aria-hidden="true" />
      <Nav current="vibes" />
      <main id="main" className="vp vd">{children}</main>
      <Footer />
    </MotionConfig>
  )
}

export default function VibePage() {
  const { slug } = useParams()
  const now = useNow()
  const navigate = useNavigate()
  const { status: authStatus } = useAuth()
  const [vibe, setVibe] = useState(null)
  const [error, setError] = useState(null)
  const [fav, setFav] = useState(false)
  const [favBusy, setFavBusy] = useState(false)
  const [shared, setShared] = useState(false)

  const load = useCallback(async () => {
    try {
      const res = await api(`/vibes/${slug}`)
      setVibe(res.data)
      setError(null)
    } catch (err) {
      setError(err.status === 404 ? 'not-found' : err.message)
    }
  }, [slug])

  useEffect(() => {
    setVibe(null)
    load()
    // Visita única por dia (contada no servidor pelo cookie anônimo).
    publicPost(`/vibes/${slug}/view`)
      .then((r) => setVibe((v) => (v ? { ...v, viewsCount: r.data.viewsCount } : v)))
      .catch(() => {})
  }, [slug, load])

  useEffect(() => {
    if (authStatus !== 'authed' || !vibe) return
    api('/me/favorites').then((r) => setFav(r.data.includes(vibe.id))).catch(() => {})
  }, [authStatus, vibe?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (vibe) document.title = `${vibe.product.name} · VibeGet`
  }, [vibe])

  const benefits = useMemo(() => {
    if (!vibe) return []
    return [
      ...FIXED_BENEFITS,
      { Icon: Coins, title: `${vibe.cashbackPercent}% de volta em GetCoin`, text: 'Se o seu Get não vencer, parte do valor pago volta para a sua carteira.' },
      ...vibe.benefits.map((b) => ({ Icon: Gift, title: b, text: null })),
    ]
  }, [vibe])

  async function toggleFav() {
    if (authStatus !== 'authed') {
      navigate(`/login?next=${encodeURIComponent(`/vibes/${slug}`)}`)
      return
    }
    setFavBusy(true)
    const next = !fav
    setFav(next)
    setVibe((v) => ({ ...v, favoritesCount: Math.max(0, v.favoritesCount + (next ? 1 : -1)) }))
    try {
      await api(`/me/favorites/${vibe.id}`, { method: next ? 'PUT' : 'DELETE' })
    } catch {
      setFav(!next)
      setVibe((v) => ({ ...v, favoritesCount: Math.max(0, v.favoritesCount + (next ? -1 : 1)) }))
    } finally {
      setFavBusy(false)
    }
  }

  async function share() {
    const url = window.location.href
    try {
      if (navigator.share) await navigator.share({ title: vibe.product.name, text: `Dispute ${vibe.product.name} no VibeGet`, url })
      else {
        await navigator.clipboard.writeText(url)
        setShared(true)
        setTimeout(() => setShared(false), 2000)
      }
    } catch { /* cancelado pelo usuário */ }
  }

  if (error === 'not-found') {
    return (
      <Shell>
        <div className="vp-empty glass vd-missing">
          <h1 className="vp-title">Vibe não encontrada</h1>
          <p className="muted">Ela pode ter sido removida ou o link está incompleto.</p>
          <Link to="/vibes" className="btn btn-coin">Ver todas as Vibes<ArrowRight size={18} weight="bold" /></Link>
        </div>
        <FeaturedVibes title="Vibes ao vivo agora" />
      </Shell>
    )
  }
  if (error) {
    return (
      <Shell>
        <div className="vp-empty glass" role="alert">
          <h1>Não foi possível carregar a Vibe.</h1>
          <p className="muted">{error}</p>
          <button type="button" className="btn btn-glass" onClick={load}>Tentar de novo</button>
        </div>
      </Shell>
    )
  }
  if (!vibe) {
    return (
      <Shell>
        <div className="vd-grid" aria-busy="true">
          <div className="vp-skel vd-skel-stage"><span className="vp-skel-media" /></div>
          <div className="vp-skel vd-skel-side"><span className="vp-skel-line" /><span className="vp-skel-line is-short" /><span className="vp-skel-line is-btn" /></div>
        </div>
      </Shell>
    )
  }

  const p = vibe.product
  const top = vibe.topGet?.totalCents
  const shown = top ?? vibe.minGetCents
  // Arredonda para baixo: 99,96% nunca vira "100% abaixo".
  const below = p.originalPriceCents ? Math.max(0, Math.floor((1 - shown / p.originalPriceCents) * 100)) : null
  const closeAt = new Date(vibe.getsCloseAt ?? vibe.endsAt).getTime()
  const live = vibe.status === 'LIVE'
  const closing = live && closeAt - now < 3 * 3600 * 1000
  const paragraphs = (p.description ?? '').split(/\n{2,}/).map((s) => s.trim()).filter(Boolean)

  return (
    <Shell>
      <nav className="vd-crumbs" aria-label="Caminho">
        <Link to="/vibes"><ArrowLeft size={16} aria-hidden="true" />Vibes</Link>
        <span aria-hidden="true">/</span>
        <Link to={`/vibes?categoria=${p.category}`}>{CAT_LABEL[p.category] ?? p.category}</Link>
      </nav>

      <div className="vd-grid">
        <section className="vd-media" aria-label="Fotos">
          <Gallery images={p.images ?? []} name={p.name} />
        </section>

        <section className="vd-side" aria-labelledby="vd-title">
          <p className="vd-kick">{[CAT_LABEL[p.category], p.brand].filter(Boolean).join(' · ')}</p>
          <h1 id="vd-title" className="vd-title">{p.name}</h1>
          {p.model && <p className="vd-model">Modelo <span className="mono">{p.model}</span></p>}

          <div className="vd-status">
            {live ? (
              <span className={`vd-live ${closing ? 'is-closing' : ''}`}>
                <span className="live-dot" aria-hidden="true" />AO VIVO
                <span className="vd-live-time mono">{closeAt > now ? countdown(closeAt - now) : 'encerrando'}</span>
              </span>
            ) : vibe.status === 'SCHEDULED' ? (
              <span className="vd-soon"><CalendarBlank size={16} aria-hidden="true" />Em breve</span>
            ) : (
              <span className="vd-soon"><Trophy size={16} aria-hidden="true" />Encerrada</span>
            )}
            <div className="vd-actions">
              <button type="button" className={`vd-icon-btn ${fav ? 'is-on' : ''}`} onClick={toggleFav} disabled={favBusy} aria-pressed={fav} aria-label={fav ? 'Remover dos favoritos' : 'Favoritar'}>
                <Heart size={20} weight={fav ? 'fill' : 'regular'} />
              </button>
              <button type="button" className="vd-icon-btn" onClick={share} aria-label="Compartilhar">
                {shared ? <Check size={20} weight="bold" /> : <ShareNetwork size={20} />}
              </button>
              <span className="sr-only" aria-live="polite">{shared ? 'Link copiado.' : ''}</span>
            </div>
          </div>

          <dl className="vd-price">
            <div className="vd-price-main">
              <dt>{vibe.status === 'ENDED' ? 'Champion Get' : top ? 'Maior Get' : 'Get mínimo'}</dt>
              <dd className="mono">{vibe.status === 'ENDED' && !top ? '—' : brl(shown)}</dd>
            </div>
            <div>
              <dt>Valor na loja</dt>
              <dd className="mono"><s>{brl(p.originalPriceCents)}</s></dd>
            </div>
            {below != null && vibe.status !== 'ENDED' && (
              <div><dt>Abaixo da loja</dt><dd className="mono coin-ink">{below}%</dd></div>
            )}
          </dl>

          <dl className="vd-stats">
            <div><dt><Gavel size={16} aria-hidden="true" />Gets</dt><dd className="mono">{vibe.confirmedGets}{vibe.goalGets ? <span className="muted">/{vibe.goalGets}</span> : null}</dd></div>
            <div><dt><Eye size={16} aria-hidden="true" />Visitas</dt><dd className="mono">{vibe.viewsCount}</dd></div>
            <div><dt><Heart size={16} aria-hidden="true" />Favoritos</dt><dd className="mono">{vibe.favoritesCount}</dd></div>
            <div><dt>Get mínimo</dt><dd className="mono">{brl(vibe.minGetCents)}</dd></div>
          </dl>

          <GetPanel key={vibe.id} vibe={vibe} now={now} onPlaced={load} />
        </section>
      </div>

      <section className="vd-block" aria-labelledby="vd-benefits">
        <h2 id="vd-benefits" className="vd-h2">Benefícios</h2>
        <ul className="vd-benefits">
          {benefits.map(({ Icon, title, text }) => (
            <li key={title} className="glass">
              <span className="auth-proof-icon" aria-hidden="true"><Icon size={18} /></span>
              <b>{title}</b>
              {text && <span>{text}</span>}
            </li>
          ))}
        </ul>
      </section>

      <div className="vd-two">
        <section className="vd-block" aria-labelledby="vd-desc">
          <h2 id="vd-desc" className="vd-h2">Descrição</h2>
          <div className="vd-desc glass">
            {paragraphs.length ? paragraphs.map((t, k) => <p key={k}>{t}</p>) : <p className="muted">Sem descrição cadastrada.</p>}
          </div>
        </section>
        <section className="vd-block" aria-labelledby="vd-specs">
          <h2 id="vd-specs" className="vd-h2">Ficha técnica</h2>
          <div className="vd-specs glass">
            {p.specs?.length || p.brand || p.model ? (
              <dl>
                {p.brand && <div><dt>Marca</dt><dd>{p.brand}</dd></div>}
                {p.model && <div><dt>Modelo</dt><dd>{p.model}</dd></div>}
                {(p.specs ?? []).map((s) => <div key={s.label}><dt>{s.label}</dt><dd>{s.value}</dd></div>)}
              </dl>
            ) : <p className="muted">Ficha técnica ainda não cadastrada.</p>}
          </div>
        </section>
      </div>

      <section className="vd-block" aria-labelledby="vd-recent">
        <h2 id="vd-recent" className="vd-h2">Últimos Gets</h2>
        <div className="vd-recent glass">
          {vibe.recentGets.length === 0 ? (
            <p className="muted">Nenhum Get confirmado ainda. O primeiro pode ser o seu.</p>
          ) : (
            <ol>
              {vibe.recentGets.map((g, k) => (
                <li key={`${g.at}-${k}`}>
                  <span className="vd-recent-who">{g.by}</span>
                  <time className="muted small" dateTime={g.at}>{timeAgo(g.at, now)}</time>
                  <b className="mono">{brl(g.totalCents)}</b>
                </li>
              ))}
            </ol>
          )}
        </div>
      </section>

      <FeaturedVibes excludeId={vibe.id} />

      {live && (
        <a href="#dar-get" className="btn btn-coin btn-lg vd-mobile-cta">
          Dar Get<ArrowRight size={18} weight="bold" />
        </a>
      )}
    </Shell>
  )
}
