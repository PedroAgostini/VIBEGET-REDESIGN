import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion, useMotionValue, useReducedMotion, useSpring } from 'framer-motion'
import {
  ArrowRight,
  ArrowUpRight,
  BellRinging,
  ArrowDownLeft,
  CaretDown,
  CaretRight,
  ChatCircle,
  Coins,
  Envelope,
  Flag,
  Lightning,
  Check,
  GithubLogo,
  Globe,
  Headset,
  List,
  Play,
  Lock,
  Package,
  Phone,
  QrCode,
  Timer,
  Storefront,
  Trophy,
  Truck,
  UserPlus,
  X,
} from '@phosphor-icons/react'
import { brl, categories, num, tickerExtra, vibes } from './data.js'
import Coin from './components/Coin.jsx'
import UserChip from './components/UserChip.jsx'
import { useAuth } from './lib/auth.jsx'
import { Link } from 'react-router-dom'

const SITE = 'https://vibeget.net'
const spring = { type: 'spring', stiffness: 100, damping: 20 }

export function useNow(interval = 1000) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), interval)
    return () => clearInterval(id)
  }, [interval])
  return now
}

function useCountUp(target, ms = 600) {
  const [val, setVal] = useState(target)
  const from = useRef(target)
  useEffect(() => {
    const start = performance.now()
    const a = from.current
    let raf
    const tick = (t) => {
      const k = Math.min(1, (t - start) / ms)
      const v = a + (target - a) * (1 - Math.pow(1 - k, 4))
      setVal(v)
      from.current = v
      if (k < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [target, ms])
  return val
}

function useActiveSection(ids) {
  const [active, setActive] = useState(null)
  useEffect(() => {
    const els = ids.map((id) => document.getElementById(id)).filter(Boolean)
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => e.isIntersecting && setActive(e.target.id))
      },
      { rootMargin: '-45% 0px -50% 0px' },
    )
    els.forEach((el) => io.observe(el))
    return () => io.disconnect()
  }, [ids])
  return active
}

export function countdown(ms) {
  const s = Math.max(0, Math.floor(ms / 1000))
  const d = Math.floor(s / 86400)
  const hh = String(Math.floor((s % 86400) / 3600)).padStart(2, '0')
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0')
  const ss = String(s % 60).padStart(2, '0')
  return d > 0 ? `${d}d ${hh}:${mm}:${ss}` : `${hh}:${mm}:${ss}`
}

/* Pulls gently toward the cursor; motion values keep it outside React renders. */
function Magnetic({ children, className = '', href, strength = 0.28 }) {
  const x = useMotionValue(0)
  const y = useMotionValue(0)
  const sx = useSpring(x, { stiffness: 150, damping: 15, mass: 0.2 })
  const sy = useSpring(y, { stiffness: 150, damping: 15, mass: 0.2 })
  const onMove = (e) => {
    const r = e.currentTarget.getBoundingClientRect()
    x.set((e.clientX - (r.left + r.width / 2)) * strength)
    y.set((e.clientY - (r.top + r.height / 2)) * strength)
  }
  const reset = () => {
    x.set(0)
    y.set(0)
  }
  return (
    <motion.a href={href} className={className} style={{ x: sx, y: sy }} onPointerMove={onMove} onPointerLeave={reset}>
      {children}
    </motion.a>
  )
}

/* Scroll-linked reveal in CSS (animation-timeline: view()); content stays visible where unsupported */
function Reveal({ children, className = '', as = 'div', delay, ...rest }) {
  const Tag = as
  return (
    <Tag className={`reveal ${className}`} {...rest}>
      {children}
    </Tag>
  )
}

const NAV = [
  ['Vibes', 'vibes'],
  ['Como funciona', 'como-funciona'],
  ['GetCoin', 'getcoin'],
  ['Suba de nível', 'niveis'],
]
const NAV_IDS = NAV.map(([, id]) => id)

export function Nav({ current } = {}) {
  const [open, setOpen] = useState(false)
  const section = useActiveSection(NAV_IDS)
  // Fora da home, a página informa qual item do menu está ativo.
  const active = current ?? section
  // Enquanto a sessão é restaurada (status 'loading'), não mostra nem visitante nem logado, para não piscar.
  const { status } = useAuth()
  return (
    <header className="nav-wrap">
      <nav className="nav glass" aria-label="Principal">
        <a href="/#top" className="brand" aria-label="VibeGet, início">
          <img src="/img/logo.png" alt="VibeGet" width="140" height="36" />
        </a>
        <ul className="nav-links">
          {NAV.map(([label, id]) => (
            <li key={id}>
              <a href={id === 'vibes' ? '/vibes' : `/#${id}`} aria-current={active === id ? 'true' : undefined}>
                {active === id && <motion.span layoutId="nav-pill" className="nav-pill" transition={spring} />}
                <span>{label}</span>
              </a>
            </li>
          ))}
        </ul>
        <div className="nav-actions">
          <button className="lang" type="button" aria-label="Idioma: português">
            <Globe size={16} /> PT <CaretDown size={12} weight="bold" />
          </button>
          {status === 'authed' && <UserChip />}
          {status === 'guest' && (
            <>
              <a className="nav-login hide-sm" href="/login">Entrar</a>
              <a className="btn btn-coin btn-sm" href="/cadastro">Criar conta</a>
            </>
          )}
          <button
            className="menu-btn"
            type="button"
            aria-expanded={open}
            aria-label={open ? 'Fechar menu' : 'Abrir menu'}
            onClick={() => setOpen((o) => !o)}
          >
            {open ? <X size={20} /> : <List size={20} />}
          </button>
        </div>
      </nav>
      <AnimatePresence>
        {open && (
          <motion.div
            className="sheet glass"
            initial={{ opacity: 0, y: -10, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -10, scale: 0.98 }}
            transition={spring}
            onClick={() => setOpen(false)}
          >
            {NAV.map(([label, id]) => (
              <a key={id} href={id === 'vibes' ? '/vibes' : `/#${id}`}>{label}<ArrowRight size={18} /></a>
            ))}
            {status === 'authed' ? (
              <Link to="/dashboard">Minha área<ArrowRight size={18} /></Link>
            ) : (
              <a href="/login">Entrar<ArrowRight size={18} /></a>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </header>
  )
}

function Simulator() {
  const now = useNow()
  const vibe = vibes[0]
  const MIN = 50
  const MAX = 600
  const [cash, setCash] = useState(160)
  const [turbo, setTurbo] = useState(true)
  const coinUsed = turbo ? cash : 0
  const total = cash + coinUsed
  const back = cash * 0.4
  const leading = total > vibe.current
  const shown = useCountUp(back)
  const stack = Math.min(7, Math.max(1, Math.round(back / 25)))
  const pct = ((cash - MIN) / (MAX - MIN)) * 100

  const presets = [50, 100, 160, 300]
  const scale = Math.max(total, vibe.current) * 1.12
  const youW = total / scale
  const topX = (vibe.current / scale) * 100

  return (
    <div className="sim-panel glass" aria-label="Simulador de Get">
      <div className="sim-build">
        <div className="sim-step-head">
          <span className="sim-step">Monte seu Get</span>
          <span className="live"><span className="live-dot" />Ao vivo</span>
        </div>

        <div className="sim-product">
          <div className="plate plate-sm is-loaded">
            <img src={vibe.img} alt={vibe.name} />
          </div>
          <div>
            <p className="wallet-name">{vibe.name}</p>
            <p className="muted small">
              Na loja <s className="mono">{brl(vibe.original)}</s>
            </p>
            <p className="mono muted small sim-timer">
              <Timer size={13} /> fecha em {countdown(vibe.endsAt - now)}
            </p>
          </div>
        </div>

        <div className="field">
          <div className="field-row">
            <label htmlFor="cash">Quanto você paga em R$</label>
            <output htmlFor="cash" className="mono field-value">{brl(cash)}</output>
          </div>
          <input
            id="cash"
            type="range"
            min={MIN}
            max={MAX}
            step="5"
            value={cash}
            style={{ '--p': `${pct}%` }}
            onChange={(e) => setCash(Number(e.target.value))}
          />
          <div className="presets" role="group" aria-label="Valores rápidos">
            {presets.map((p) => (
              <button
                key={p}
                type="button"
                className={`preset mono ${cash === p ? 'is-on' : ''}`}
                aria-pressed={cash === p}
                onClick={() => setCash(p)}
              >
                R$ {p}
              </button>
            ))}
          </div>
        </div>

        <label className="toggle">
          <input type="checkbox" checked={turbo} onChange={(e) => setTurbo(e.target.checked)} />
          <span className="switch" aria-hidden="true" />
          <span>
            <b>Turbinar com GetCoin</b>
            <span className="muted small block">Some GetCoin até o mesmo valor pago em R$</span>
          </span>
        </label>
      </div>

      <div className="sim-result">
        <div className="sim-step-head">
          <span className="sim-step">Resultado</span>
          <span className="tag">Simulação</span>
        </div>

        <div className="sim-sum">
          <div><span className="muted small">Pix</span><b className="mono">{brl(cash)}</b></div>
          <span className="sim-op" aria-hidden="true">+</span>
          <div><span className="muted small">GetCoin</span><b className="mono coin-ink">{num(coinUsed)}</b></div>
          <span className="sim-op" aria-hidden="true">=</span>
          <div className="sim-total"><span className="muted small">Na disputa</span><b className="mono">{brl(total)}</b></div>
        </div>

        <div className="race" aria-hidden="true">
          <div className="race-track">
            <span className={`race-you ${leading ? 'is-lead' : ''}`} style={{ transform: `scaleX(${youW})` }} />
            <span className="race-top" style={{ left: `${topX}%` }}>
              <span className="race-top-label mono">Maior Get {brl(vibe.current)}</span>
            </span>
          </div>
        </div>
        <p className={`standing ${leading ? 'is-lead' : ''}`} aria-live="polite">
          {leading
            ? 'Seu Get passa o maior atual. Se ninguém superar até o fim, é Champion Get.'
            : `Faltam ${brl(Math.max(0, vibe.current - total))} para empatar com o maior Get. Suba o valor ou turbine.`}
        </p>

        <div className="outcomes">
          <div className={`outcome outcome-win ${leading ? 'is-on' : ''}`}>
            <Trophy size={20} />
            <p><b>Se for o maior Get</b><span>O iPhone é seu.</span></p>
          </div>
          <div className={`outcome outcome-back ${leading ? '' : 'is-on'}`}>
            <span className="stack" aria-hidden="true">
              {Array.from({ length: stack }, (_, i) => (
                <span key={i} className="stack-coin" style={{ '--i': i }}><Coin size={26} /></span>
              ))}
            </span>
            <p>
              <b>Se não for</b>
              <span><span className="mono coin-ink back-num">+{num(shown)}</span> GetCoin de volta</span>
            </p>
          </div>
        </div>

        <a className="btn btn-coin btn-block" href="/cadastro">
          Dar Get de {brl(total)} <ArrowRight size={18} weight="bold" />
        </a>
      </div>
    </div>
  )
}

function Hero() {
  return (
    <section className="hero-banner" id="top" aria-labelledby="hero-title">
      <img src="./img/hero-bg.svg" alt="" className="hero-bg" />
      <div className="hero-inner">
        <a href="#getcoin" className="hero-badge fade-in-1">
          <span className="hero-badge-label">40%</span>
          <span>volta em GetCoin se você não vencer</span>
        </a>
        <h1 id="hero-title" className="hero-title fade-in-2">
          Dê seu Get.
          <br />
          <em>Leve o prêmio ou GetCoin.</em>
        </h1>
        <p className="hero-desc fade-in-3">
          Leilões de eletrônicos novos e lacrados, com Get mínimo que costuma ser 200 vezes menor que o preço
          original. Perdeu a disputa? O GetCoin volta para a sua carteira e turbina o próximo Get.
        </p>
        <div className="hero-actions fade-in-4">
          <Magnetic className="btn btn-coin btn-lg" href="/cadastro">
            Criar conta e ganhar GetCoin <ArrowRight size={20} weight="bold" />
          </Magnetic>
          <a className="hero-secondary" href="#como-funciona">
            Veja como funciona <Play size={16} weight="fill" />
          </a>
        </div>
      </div>

      <div className="hero-live fade-in-5">
        <p>Na disputa agora</p>
        <ul>
          {vibes.map((v) => (
            <li key={v.slug}>
              <a href={`/vibes/${v.slug}`} className="hero-live-item">
                <span className={`hero-live-thumb ${v.dark ? 'is-dark' : ''}`}><img src={v.img} alt="" /></span>
                <span className="hero-live-text">
                  <span>{v.name}</span>
                  <b className="mono">{brl(v.current)}</b>
                </span>
              </a>
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}

function SimSection() {
  return (
    <section id="simulador" className="section sim" aria-labelledby="sim-title">
      <Reveal className="sim-head">
        <h2 id="sim-title">Faça a conta antes de dar o Get.</h2>
        <p className="muted">
          Arraste o valor, ligue o GetCoin e veja os dois finais possíveis: o produto na sua mão ou 40% do que você
          pagou de volta na carteira.
        </p>
      </Reveal>
      <Simulator />
      <ul className="sim-proof">
        <li><Package size={20} /><span><b>Novos e lacrados</b>Com garantia de fábrica</span></li>
        <li><QrCode size={20} /><span><b>Pix ou cartão</b>Pagamento rápido do Get</span></li>
        <li><Truck size={20} /><span><b>Todo o Brasil</b>Entrega com rastreamento</span></li>
        <li><Headset size={20} /><span><b>Suporte 24/7</b>Equipe sempre pronta</span></li>
      </ul>
    </section>
  )
}

function Ticker() {
  const items = [...vibes, ...tickerExtra]
  const row = items.map((v, i) => (
    <li key={i}>
      <span className="t-name">{v.name}</span>
      <span className="t-coin mono">{brl(v.current)}</span>
    </li>
  ))
  return (
    <div className="ticker" aria-label="Vibes em andamento">
      <span className="ticker-label"><span className="live-dot" />Vibes ao vivo</span>
      <div className="ticker-track">
        <ul>{row}</ul>
        <ul aria-hidden="true">{row}</ul>
      </div>
    </div>
  )
}

/* 3D tilt for the membership cards; writes CSS vars directly, no React state */
function tilt(e) {
  const el = e.currentTarget
  const r = el.getBoundingClientRect()
  const px = (e.clientX - r.left) / r.width
  const py = (e.clientY - r.top) / r.height
  el.style.setProperty('--ry', `${(px - 0.5) * 14}deg`)
  el.style.setProperty('--rx', `${(0.5 - py) * 12}deg`)
  el.style.setProperty('--gx', `${px * 100}%`)
  el.style.setProperty('--gy', `${py * 100}%`)
}

function untilt(e) {
  const el = e.currentTarget
  el.style.setProperty('--ry', '0deg')
  el.style.setProperty('--rx', '0deg')
}

export function spotlight(e) {
  const r = e.currentTarget.getBoundingClientRect()
  e.currentTarget.style.setProperty('--mx', `${e.clientX - r.left}px`)
  e.currentTarget.style.setProperty('--my', `${e.clientY - r.top}px`)
}

const CAT_LABEL = { smartphones: 'Smartphone', notebooks: 'Notebook', games: 'Games', audio: 'Áudio', wearables: 'Wearable' }

function VibeCard({ v, now }) {
  const left = v.endsAt - now
  const closing = left < 3 * 3600 * 1000
  const progress = Math.min(100, (v.gets / v.goal) * 100)
  const below = Math.round((1 - v.current / v.original) * 100)
  const href = `/vibes/${v.slug}`
  return (
    <motion.article
      layout
      initial={{ opacity: 0, y: 24 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.96 }}
      transition={spring}
      className={`vibe glass spot ${closing ? 'is-closing' : ''}`}
      onPointerMove={spotlight}
    >
      <a href={href} className={`plate vibe-media ${v.dark ? 'plate-dark' : ''}`} tabIndex={-1} aria-hidden="true">
        <img
          src={v.img}
          alt=""
          loading="lazy"
          onLoad={(e) => e.currentTarget.parentElement.classList.add('is-loaded')}
        />
        <span className={`chip-time mono ${closing ? 'is-closing' : ''}`}>
          {closing ? <span className="live-dot" /> : <Timer size={13} />} {countdown(left)}
        </span>
      </a>
      <div className="vibe-body">
        <div className="vibe-title">
          <span className="vibe-cat">{CAT_LABEL[v.category]}</span>
          <h3><a href={href}>{v.name}</a></h3>
        </div>
        <div className="vibe-price">
          <span className="muted small">Maior Get</span>
          <b className="mono price">{brl(v.current)}</b>
          <span className="vibe-save small">
            <b>{below}% abaixo</b> da loja<span className="sep"> · </span><s className="mono">{brl(v.original)}</s>
          </span>
        </div>
        <div className="meter" role="img" aria-label={`${v.gets} de ${v.goal} Gets para encerrar`}>
          <div className="meter-bar"><span style={{ transform: `scaleX(${progress / 100})` }} /></div>
          <span className="meter-label small muted">
            <span><b className="ink mono">{v.gets}</b>/{v.goal} Gets</span>
            <span>{closing ? 'Encerrando' : 'Aberta'}</span>
          </span>
        </div>
        <a className={`btn btn-block vibe-cta ${closing ? 'btn-coin' : 'btn-glass'}`} href={href}>
          {closing ? 'Dar Get agora' : 'Dar Get'} <ArrowRight size={17} weight="bold" />
        </a>
      </div>
    </motion.article>
  )
}

function AlertForm({ label }) {
  const [email, setEmail] = useState('')
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)
  const submit = (e) => {
    e.preventDefault()
    if (!email.trim()) return setError('Informe um e-mail para receber o aviso.')
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return setError('Esse e-mail parece incompleto. Confira e tente de novo.')
    setError('')
    setDone(true)
  }
  if (done) {
    return (
      <p className="alert-done" role="status">
        <Check size={18} weight="bold" /> Pronto. Avisamos em <b>{email}</b> quando abrir uma Vibe de {label}.
      </p>
    )
  }
  return (
    <form className="alert-form" onSubmit={submit} noValidate>
      <div className="input-block">
        <label htmlFor="alert-email">Seu e-mail</label>
        <input
          id="alert-email"
          type="email"
          inputMode="email"
          autoComplete="email"
          placeholder="voce@email.com"
          value={email}
          aria-invalid={!!error}
          aria-describedby={error ? 'alert-error' : 'alert-help'}
          onChange={(e) => {
            setEmail(e.target.value)
            if (error) setError('')
          }}
        />
        {error ? (
          <span id="alert-error" className="input-error">{error}</span>
        ) : (
          <span id="alert-help" className="input-help">Um e-mail por Vibe nova. Nada além disso.</span>
        )}
      </div>
      <button className="btn btn-coin" type="submit">Me avise</button>
    </form>
  )
}

function Vibes() {
  const now = useNow()
  const [cat, setCat] = useState('todos')
  const counts = useMemo(() => {
    const c = { todos: vibes.length }
    vibes.forEach((v) => (c[v.category] = (c[v.category] || 0) + 1))
    return c
  }, [])
  const list = (cat === 'todos' ? vibes : vibes.filter((v) => v.category === cat))
    .slice()
    .sort((a, b) => a.endsAt - b.endsAt)
  const label = categories.find((c) => c.id === cat)?.label

  return (
    <section id="vibes" className="section" aria-labelledby="vibes-title">
      <Reveal className="section-head is-center">
        <h2 id="vibes-title">Vibes abertas agora</h2>
      </Reveal>

      <div className="chips is-center" role="tablist" aria-label="Categorias">
        {categories.map((c) => (
          <button
            key={c.id}
            role="tab"
            aria-selected={cat === c.id}
            className={`chip ${cat === c.id ? 'is-on' : ''}`}
            onClick={(e) => {
              setCat(c.id)
              e.currentTarget.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' })
            }}
          >
            {cat === c.id && <motion.span layoutId="chip-pill" className="chip-pill" transition={spring} />}
            <span className="chip-label">{c.label}</span>
            <span className="chip-count mono">{counts[c.id] || 0}</span>
          </button>
        ))}
      </div>

      <AnimatePresence mode="popLayout" initial={false}>
        {list.length ? (
          <motion.div key="grid" layout className={`vibe-grid n-${list.length}`}>
            <AnimatePresence mode="popLayout">
              {list.map((v) => <VibeCard key={v.slug} v={v} now={now} />)}
            </AnimatePresence>
          </motion.div>
        ) : (
          <motion.div
            key={`empty-${cat}`}
            className="empty glass"
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={spring}
          >
            <div className="empty-copy">
              <span className="empty-icon"><BellRinging size={26} /></span>
              <h3>Nenhuma Vibe de {label} aberta agora.</h3>
              <p className="muted">Elas abrem sem hora marcada. Deixe seu e-mail e você fica sabendo antes da fila.</p>
            </div>
            <AlertForm label={label} />
          </motion.div>
        )}
      </AnimatePresence>

      <div className="vibes-cta">
        <Magnetic className="btn btn-coin btn-lg" href="/vibes">
          Ver todas as Vibes <ArrowRight size={20} weight="bold" />
        </Magnetic>      </div>
    </section>
  )
}

function GetCoin() {
  const rows = [
    { d: '12 set', icon: QrCode, t: 'Get na Vibe Galaxy S24 Ultra', s: 'Pago via Pix', v: '− R$ 3,95' },
    { d: '12 set', icon: Coins, t: 'GetCoin somado ao Get', s: 'Get total na disputa: R$ 7,90', v: '− 3,95', coin: true },
    { d: '14 set', icon: Flag, t: 'Vibe encerrada', s: 'Outro Get foi o maior', pill: 'Não venceu', dim: true },
    { d: '14 set', icon: ArrowDownLeft, t: 'GetCoin creditado', s: '40% de R$ 3,95', v: '+ 1,58', coin: true, plus: true },
    { d: '15 set', icon: Lightning, t: 'Novo Get na Vibe iPhone 15 Pro Max', s: 'R$ 1,58 + 1,58 GetCoin', v: 'R$ 3,16' },
  ]
  return (
    <section id="getcoin" className="section getcoin" aria-labelledby="getcoin-title">
      <div className="gc-bento">
        <Reveal className="gc-intro glass spot" onPointerMove={spotlight}>
          <h2 id="getcoin-title">Perdeu a Vibe? Seu Get não virou pó.</h2>
          <p className="lede">
            GetCoin é o saldo da sua carteira VibeGet. Ele nasce das Vibes que você não venceu e volta para a disputa
            na próxima, dobrando o seu poder de Get.
          </p>
          <div className="gc-coin" aria-hidden="true"><Coin size={260} /></div>
        </Reveal>

        <Reveal className="gc-stat glass spot" onPointerMove={spotlight}>
          <b className="gc-num mono">40%</b>
          <p>do valor pago em R$ volta como GetCoin quando o seu Get não vence.</p>
        </Reveal>

        <Reveal className="gc-stat glass spot" onPointerMove={spotlight}>
          <b className="gc-num mono">1:1</b>
          <p>Some GetCoin até o mesmo valor pago em dinheiro. R$ 3,95 + 3,95 GetCoin = Get de R$ 7,90.</p>
        </Reveal>

        <Reveal className="gc-bonus glass spot" onPointerMove={spotlight}>
          <Coin size={40} />
          <p>
            <b>Começa com saldo.</b> Conta nova já entra com GetCoin de boas-vindas, e indicar amigos também rende
            GetCoin.
          </p>
        </Reveal>
      </div>

      <Reveal className="statement glass" aria-label="Exemplo de extrato">
        <div className="statement-head">
          <p><b>Como fica na sua carteira</b></p>
          <span className="tag">Exemplo</span>
        </div>
        <ol className="timeline">
          {rows.map((r, i) => (
            <li key={i} className={`${r.dim ? 'is-dim' : ''} ${r.plus ? 'is-plus' : ''}`} style={{ '--i': i }}>
              <span className="t-top">
                <span className="t-icon"><r.icon size={17} weight="duotone" /></span>
                <span className="mono muted s-date">{r.d}</span>
              </span>
              {r.pill ? (
                <span className="t-pill">{r.pill}</span>
              ) : (
                <span className={`mono s-val ${r.coin ? 'coin-ink' : ''}`}>
                  {r.coin && <Coin size={15} />}{r.v}
                </span>
              )}
              <b>{r.t}</b>
              <span className="muted small">{r.s}</span>
              {i < rows.length - 1 && (
                <span className="t-link" aria-hidden="true"><CaretRight size={12} weight="bold" /></span>
              )}
            </li>
          ))}
        </ol>
        <div className="statement-foot">
          <span className="muted">Resultado</span>
          <span>Duas Vibes disputadas com <b className="mono">R$ 5,53</b> em dinheiro.</span>
        </div>
      </Reveal>
    </section>
  )
}

function HowItWorks() {
  const steps = [
    [UserPlus, 'Crie sua conta', 'Cadastro gratuito e rápido. Você já entra com GetCoin de boas-vindas.'],
    [Storefront, 'Escolha a Vibe', 'Cada produto tem um Get mínimo, que costuma ser pelo menos 200 vezes menor que o preço original.'],
    [Lightning, 'Dê seu Get', 'Pague via Pix ou cartão e some GetCoin até o mesmo valor para chegar mais alto.'],
    [Trophy, 'O maior Get leva', 'A Vibe fecha em 1 a 15 dias ou ao bater a meta de Gets. Não venceu? 40% volta em GetCoin.'],
  ]
  return (
    <section id="como-funciona" className="section how" aria-labelledby="how-title">
      <Reveal className="section-head is-center how-head-center">
        <h2 id="how-title">Do cadastro ao Champion Get</h2>
      </Reveal>
      <ol className="path">
        {steps.map(([Icon, t, d], i) => (
          <li key={t} className={`path-step glass spot ${i === steps.length - 1 ? 'is-final' : ''}`} onPointerMove={spotlight}>
            <span className="path-node" aria-hidden="true" />
            <span className="path-icon"><Icon size={22} weight="duotone" /></span>
            <h3>{t}</h3>
            <p className="muted">{d}</p>
          </li>
        ))}
      </ol>
      <div className="vibes-cta how-cta">
        <Magnetic className="btn btn-coin btn-lg" href="/cadastro">
          Criar conta grátis <ArrowRight size={20} weight="bold" />
        </Magnetic>
        <a className="text-link" href={`${SITE}/regras`}>Ler as regras completas <ArrowUpRight size={16} /></a>
      </div>
    </section>
  )
}

function Levels() {
  return (
    <section id="niveis" className="section levels" aria-labelledby="levels-title">
      <Reveal className="section-head is-center levels-head">
        <h2 id="levels-title">De Explorador a Viber.</h2>
      </Reveal>

      <div className="tiers">
        <Reveal className="tier-col">
          <div className="mcard mcard-gold" onPointerMove={tilt} onPointerLeave={untilt}>
            <div className="mcard-top">
              <span className="mcard-brand">VibeGet</span>
              <span className="tier-chip"><Check size={13} weight="bold" /> Ativo</span>
            </div>
            <span className="mcard-emv" aria-hidden="true" />
            <div className="mcard-bottom">
              <div>
                <span className="mcard-label">Nível 1</span>
                <p className="mcard-name">Explorador</p>
              </div>
              <Coin size={46} />
            </div>
          </div>
          <p className="tier-desc">Liberado no cadastro. Entre em qualquer Vibe, junte GetCoin e combine R$ com saldo.</p>
        </Reveal>

        <div className="tier-link" aria-hidden="true">
          <span className="tier-link-line" />
          <span className="tier-link-label"><Trophy size={14} weight="fill" /> 1º Champion Get</span>
          <span className="tier-link-line" />
          <CaretRight size={16} weight="bold" className="tier-link-caret" />
        </div>

        <Reveal className="tier-col">
          <div className="mcard mcard-black" onPointerMove={tilt} onPointerLeave={untilt}>
            <div className="mcard-top">
              <span className="mcard-brand">VibeGet</span>
              <span className="tier-chip is-locked"><Lock size={13} /> Bloqueado</span>
            </div>
            <span className="mcard-emv" aria-hidden="true" />
            <div className="mcard-bottom">
              <div>
                <span className="mcard-label">Nível 2</span>
                <p className="mcard-name">Viber</p>
              </div>
              <span className="tier-trophy"><Trophy size={26} weight="duotone" /></span>
            </div>
          </div>
          <p className="tier-desc">Conquistado no seu primeiro Champion Get. Prova de que você dominou a estratégia.</p>        </Reveal>
      </div>

      <ul className="tips">
        <li className="glass">
          <Coins size={22} weight="duotone" />
          <p><b>Acumule GetCoin.</b> Os 40% das Vibes que você não vence viram saldo para a próxima disputa.</p>
        </li>
        <li className="glass">
          <Lightning size={22} weight="duotone" />
          <p><b>Dobre seu poder de fogo.</b> Iguale o valor em dinheiro com GetCoin e chegue mais perto do Champion Get.</p>
        </li>
      </ul>

      <div className="vibes-cta how-cta">
        <Magnetic className="btn btn-coin btn-lg" href="/cadastro">
          Começar como Explorador <ArrowRight size={20} weight="bold" />
        </Magnetic>
        <a className="text-link" href={`${SITE}/suba-de-nivel`}>Como subir de nível <ArrowUpRight size={16} /></a>
      </div>
    </section>
  )
}

function Closing() {
  return (
    <section id="cadastro" className="closing-drench" aria-labelledby="closing-title">
      <div className="cd-float" aria-hidden="true">
        <span className="fc fc-1"><Coin size={200} /></span>
        <span className="fc fc-2"><Coin size={130} /></span>
        <span className="fc fc-3"><Coin size={110} /></span>
        <span className="fc fc-4"><Coin size={84} /></span>
        <span className="fc fc-5"><Coin size={70} /></span>
        <span className="cd-sticker">40% volta em GetCoin</span>
        <span className="cd-live">
          <span className="cd-live-thumb"><img src={vibes[0].img} alt="" /></span>
          <span className="cd-live-text">
            <span>{vibes[0].name}</span>
            <b className="mono">Maior Get {brl(vibes[0].current)}</b>
          </span>
        </span>
      </div>

      <div className="cd-inner">
        <h2 id="closing-title">
          Sua primeira Vibe
          <br />
          começa com <span className="cd-gold">GetCoin</span>
        </h2>
        <p>Crie a conta, escolha um produto e dê o primeiro Get. Se não vencer, o saldo fica com você.</p>
        <div className="cd-actions">
          <Magnetic className="btn btn-lg btn-coin" href="/cadastro">
            Criar conta grátis <ArrowRight size={20} weight="bold" />
          </Magnetic>
          <a className="btn btn-lg btn-outline-light" href="/login">Já tenho conta</a>
        </div>
        <a className="cd-mail" href="mailto:contato@leilaocash.com">contato@leilaocash.com</a>
      </div>
    </section>
  )
}

const FOOTER_LINKS = [
  {
    label: 'Plataforma',
    links: [
      { title: 'Vibes abertas', href: '/vibes' },
      { title: 'Como funciona', href: '/#como-funciona' },
      { title: 'GetCoin', href: '/#getcoin' },
      { title: 'Suba de nível', href: '/#niveis' },
    ],
  },
  {
    label: 'Sua conta',
    links: [
      { title: 'Criar conta', href: "/cadastro" },
      { title: 'Entrar', href: "/login" },
      { title: 'Todas as Vibes', href: '/vibes' },
      { title: 'Dúvidas frequentes', href: `${SITE}/faq` },
    ],
  },
  {
    label: 'Legal',
    links: [
      { title: 'Termos de uso', href: `${SITE}/termos` },
      { title: 'Privacidade', href: `${SITE}/privacidade` },
      { title: 'Regras', href: `${SITE}/regras` },
    ],
  },
  {
    label: 'Contato',
    links: [
      { title: 'contato@leilaocash.com', href: 'mailto:contato@leilaocash.com', icon: Envelope },
      { title: '+55 (11) 3000-0000', href: 'tel:+551130000000', icon: Phone },
      { title: 'Fale conosco', href: `${SITE}/contato`, icon: ChatCircle },
    ],
  },
]

function FooterReveal({ delay = 0.1, className, children }) {
  const reduce = useReducedMotion()
  if (reduce) return <div className={className}>{children}</div>
  return (
    <motion.div
      className={className}
      initial={{ filter: 'blur(4px)', y: -8, opacity: 0 }}
      whileInView={{ filter: 'blur(0px)', y: 0, opacity: 1 }}
      viewport={{ once: true }}
      transition={{ delay, duration: 0.8 }}
    >
      {children}
    </motion.div>
  )
}

export function Footer() {
  return (
    <footer className="footer-x">
      <span className="footer-glow" aria-hidden="true" />
      <div className="footer-grid">
        <FooterReveal className="footer-brand">
          <img src="/img/logo.png" alt="VibeGet" width="140" height="36" />
          <p>Leilões de eletrônicos novos, lacrados e com garantia, com GetCoin em cada Get.</p>
          <p className="footer-copy">© {new Date().getFullYear()} VibeGet. Todos os direitos reservados.</p>
        </FooterReveal>

        <div className="footer-cols">
          {FOOTER_LINKS.map((section, i) => (
            <FooterReveal key={section.label} delay={0.1 + i * 0.1}>
              <h3 className="footer-label">{section.label}</h3>
              <ul>
                {section.links.map((link) => (
                  <li key={link.title}>
                    <a href={link.href}>
                      {link.icon && <link.icon size={16} />}
                      {link.title}
                    </a>
                  </li>
                ))}
              </ul>
            </FooterReveal>
          ))}
        </div>
      </div>
      <div className="footer-note">
        <span>Proposta de redesign. Tempos, contagens de Gets e extrato são ilustrativos.</span>
        <a className="dev-credit" href="https://github.com/PedroAgostini" target="_blank" rel="noopener noreferrer">
          <GithubLogo size={15} weight="fill" />
          <span>Desenvolvido por</span>
          <b>Pedro Agostini</b>
        </a>
      </div>
    </footer>
  )
}

export default function App() {
  return (
    <>
      <a className="skip-link" href="#main">Pular para o conteúdo</a>
      <div className="atmos" aria-hidden="true" />
      <Nav />
      <main id="main">
        <Hero />
        <Ticker />
        <SimSection />
        <Vibes />
        <GetCoin />
        <HowItWorks />
        <Levels />
        <Closing />
      </main>
      <Footer />
    </>
  )
}
