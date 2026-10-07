import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion, MotionConfig, useReducedMotion } from 'framer-motion'
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import {
  ArrowLeft, ArrowRight, Check, CircleNotch, Coins, Package, PixLogo, Ticket,
} from '@phosphor-icons/react'
import { fieldErrors, login, publicPost, register } from '../lib/api.js'
import { ErrorLine, Field, FormAlert, PasswordField, Submit } from '../components/form.jsx'
import { safeNext, useAuth } from '../lib/auth.jsx'

const SITE = 'https://vibeget.net'
const ease = [0.16, 1, 0.3, 1]

const COPY = {
  login: {
    title: 'Sua carteira te espera.',
    lede: 'Entre para acompanhar seus Gets, o saldo de GetCoin e as Vibes em que você está na disputa.',
  },
  cadastro: {
    title: 'Entre na disputa sem sair de mãos vazias.',
    lede: 'Quem não vence recebe 40% do valor pago de volta em GetCoin, e o GetCoin turbina o próximo Get.',
  },
  conta: {
    title: 'Sua conta, de volta em minutos.',
    lede: 'Seu saldo de GetCoin e seus Gets continuam guardados enquanto você recupera o acesso.',
  },
}

/* ---------------- Formulários ---------------- */

function LoginForm({ onDone, onForgot }) {
  const [params] = useSearchParams()
  const [email, setEmail] = useState(params.get('email') ?? '')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  async function submit(e) {
    e.preventDefault()
    setError(null)
    if (!email.trim() || !password) return setError('Informe seu e-mail e sua senha.')
    setBusy(true)
    try {
      await login({ email: email.trim(), password })
      onDone()
    } catch (err) {
      setError(err.message)
      setBusy(false)
    }
  }

  return (
    <form className="af-form" onSubmit={submit} noValidate aria-label="Entrar">
      <FormAlert>{error}</FormAlert>
      <Field
        label="E-mail" type="email" name="email" autoComplete="email" inputMode="email" required
        value={email} onChange={(e) => setEmail(e.target.value)} placeholder="voce@email.com"
      />
      <PasswordField
        name="password" autoComplete="current-password" required
        value={password} onChange={(e) => setPassword(e.target.value)}
        aside={<button type="button" className="af-inline-link" onClick={() => onForgot(email)}>Esqueci minha senha</button>}
      />
      <Submit busy={busy} busyLabel="Entrando…">Entrar</Submit>
    </form>
  )
}

const STEPS = ['Seus dados', 'Sua senha']
// Campos do servidor que pertencem ao passo 1: um erro neles leva a pessoa de volta.
const STEP1_FIELDS = ['name', 'email']

function StepHeader({ step }) {
  return (
    <div className="af-steps">
      <p className="af-steps-label">
        <span className="mono">{step + 1}/{STEPS.length}</span> {STEPS[step]}
      </p>
      <div className="af-steps-bar" aria-hidden="true">
        {STEPS.map((s, i) => <span key={s} className={i <= step ? 'is-done' : ''} />)}
      </div>
    </div>
  )
}

function RegisterForm({ onDone }) {
  const [params] = useSearchParams()
  const initialCoupon = params.get('cupom') ?? ''
  const initialRef = params.get('ref') ?? ''
  const [step, setStep] = useState(0)
  const [values, setValues] = useState({ name: '', email: '', password: '', couponCode: initialCoupon, referralCode: initialRef })
  const [terms, setTerms] = useState(false)
  const [codesOpen, setCodesOpen] = useState(Boolean(initialCoupon || initialRef))
  const [errors, setErrors] = useState({})
  const [alert, setAlert] = useState(null)
  const [busy, setBusy] = useState(false)
  const formRef = useRef(null)
  const moved = useRef(false)
  const set = (k) => (e) => setValues((v) => ({ ...v, [k]: e.target.value }))
  const longEnough = values.password.length >= 10

  // Ao trocar de passo, o foco vai para o primeiro campo quando o passo novo termina de entrar
  // (não no carregamento da página).
  function focusFirst() {
    if (!moved.current) return
    formRef.current?.querySelector('.af-step input:not([tabindex="-1"])')?.focus()
  }

  function goTo(next) {
    moved.current = true
    setStep(next)
  }

  function validateStep1() {
    const found = {}
    if (values.name.trim().length < 2) found.name = 'Informe seu nome.'
    if (!/^\S+@\S+\.\S+$/.test(values.email.trim())) found.email = 'Informe um e-mail válido.'
    return found
  }

  function validateStep2() {
    const found = {}
    if (!longEnough) found.password = 'A senha precisa ter pelo menos 10 caracteres.'
    if (!terms) found.acceptTerms = 'Para criar a conta, aceite os termos de uso.'
    return found
  }

  async function submit(e) {
    e.preventDefault()
    setAlert(null)
    if (step === 0) {
      const found = validateStep1()
      setErrors(found)
      if (!Object.keys(found).length) goTo(1)
      return
    }
    const found = validateStep2()
    setErrors(found)
    if (Object.keys(found).length) return
    setBusy(true)
    const body = { name: values.name.trim(), email: values.email.trim(), password: values.password, acceptTerms: true }
    if (values.couponCode.trim()) body.couponCode = values.couponCode.trim()
    if (values.referralCode.trim()) body.referralCode = values.referralCode.trim()
    try {
      const data = await register(body)
      onDone({ couponApplied: body.couponCode ? data.couponApplied : undefined })
    } catch (err) {
      setBusy(false)
      const byField = fieldErrors(err)
      if (Object.keys(byField).length) {
        setErrors(byField)
        if (byField.referralCode || byField.couponCode) setCodesOpen(true)
        if (STEP1_FIELDS.some((f) => byField[f])) goTo(0)
      } else if (err.code === 'ACCOUNT_EXISTS') {
        goTo(0)
        setAlert(
          <>
            {err.message}{' '}
            <Link to={`/login?email=${encodeURIComponent(values.email.trim())}`} className="af-inline-link">Entrar com esse e-mail</Link>
          </>,
        )
      } else {
        setAlert(err.message)
      }
    }
  }

  return (
    <form ref={formRef} className="af-form" onSubmit={submit} noValidate aria-label={`Criar conta, passo ${step + 1} de ${STEPS.length}: ${STEPS[step]}`}>
      <StepHeader step={step} />
      <FormAlert>{alert}</FormAlert>
      <AnimatePresence mode="wait" initial={false}>
        {step === 0 ? (
          <motion.div
            key="s1" className="af-step"
            initial={{ opacity: 0, x: -16 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -16 }}
            transition={{ duration: 0.28, ease }} onAnimationComplete={focusFirst}
          >
            <Field
              label="Nome completo" name="name" autoComplete="name" required
              value={values.name} onChange={set('name')} error={errors.name}
            />
            <Field
              label="E-mail" type="email" name="email" autoComplete="email" inputMode="email" required
              value={values.email} onChange={set('email')} error={errors.email} placeholder="voce@email.com"
            />
            <Submit busy={false}>Continuar</Submit>
          </motion.div>
        ) : (
          <motion.div
            key="s2" className="af-step"
            initial={{ opacity: 0, x: 16 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 16 }}
            transition={{ duration: 0.28, ease }} onAnimationComplete={focusFirst}
          >
            <div className="af-who">
              <span className="af-who-text">Conta para <b>{values.email.trim()}</b></span>
              <button type="button" className="af-inline-link" onClick={() => goTo(0)}>Alterar</button>
            </div>
            {/* Para o gerenciador de senhas associar a senha a este e-mail */}
            <input className="af-hidden" type="email" name="username" autoComplete="username" value={values.email.trim()} readOnly tabIndex={-1} aria-hidden="true" />
            <PasswordField
              name="new-password" autoComplete="new-password" required
              value={values.password} onChange={set('password')} error={errors.password}
              hint={
                <p className={`af-rule ${longEnough ? 'is-met' : ''}`}>
                  <span className="af-rule-dot" aria-hidden="true">{longEnough && <Check size={11} weight="bold" />}</span>
                  Pelo menos 10 caracteres <span className="mono">{Math.min(values.password.length, 10)}/10</span>
                </p>
              }
            />

            <div className="af-codes">
              <button
                type="button" className="af-codes-toggle" aria-expanded={codesOpen} aria-controls="af-codes-panel"
                onClick={() => setCodesOpen((o) => !o)}
              >
                <Ticket size={18} aria-hidden="true" />
                Tenho um cupom ou código de indicação
                <ArrowRight size={16} className="af-codes-caret" aria-hidden="true" />
              </button>
              <AnimatePresence initial={false}>
                {codesOpen && (
                  <motion.div
                    id="af-codes-panel" className="af-codes-panel"
                    initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.35, ease }}
                  >
                    <div className="af-codes-grid">
                      <Field
                        label="Cupom" name="coupon" autoComplete="off" autoCapitalize="characters"
                        value={values.couponCode} onChange={set('couponCode')} error={errors.couponCode}
                      />
                      <Field
                        label="Código de indicação" name="referral" autoComplete="off" autoCapitalize="characters"
                        value={values.referralCode} onChange={set('referralCode')} error={errors.referralCode}
                      />
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            <div className="af-check-wrap">
              <label className="af-check">
                <input type="checkbox" checked={terms} onChange={(e) => setTerms(e.target.checked)} aria-invalid={errors.acceptTerms ? 'true' : undefined} />
                <span className="af-box" aria-hidden="true"><Check size={14} weight="bold" /></span>
                <span>
                  Li e aceito os <a href={`${SITE}/termos`} target="_blank" rel="noopener noreferrer">termos de uso</a> e a{' '}
                  <a href={`${SITE}/privacidade`} target="_blank" rel="noopener noreferrer">política de privacidade</a>.
                </span>
              </label>
              {errors.acceptTerms && <ErrorLine>{errors.acceptTerms}</ErrorLine>}
            </div>

            <Submit busy={busy} busyLabel="Criando sua conta…">Criar conta grátis</Submit>
          </motion.div>
        )}
      </AnimatePresence>
      <p className="af-fine">CPF, celular e data de nascimento só são pedidos antes do seu primeiro Get.</p>
    </form>
  )
}

function ForgotForm({ initialEmail, onBack }) {
  const [email, setEmail] = useState(initialEmail)
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState(null)

  async function submit(e) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      await publicPost('/auth/forgot-password', { email: email.trim() })
      setSent(true)
    } catch (err) {
      setError(fieldErrors(err).email ?? err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="af-form">
      <button type="button" className="af-back" onClick={onBack}><ArrowLeft size={16} aria-hidden="true" />Voltar para entrar</button>
      <h2 className="af-title">Criar uma nova senha</h2>
      {sent ? (
        <FormAlert tone="ok">
          Se existir uma conta com <b>{email.trim()}</b>, enviamos um link para você criar uma nova senha. Confira a caixa de entrada e o spam.
        </FormAlert>
      ) : (
        <form className="af-form" onSubmit={submit} noValidate aria-label="Recuperar senha">
          <p className="af-sub">Informe o e-mail da sua conta e enviamos um link para você criar uma nova senha.</p>
          <FormAlert>{error}</FormAlert>
          <Field
            label="E-mail" type="email" name="email" autoComplete="email" inputMode="email" required
            value={email} onChange={(e) => setEmail(e.target.value)} placeholder="voce@email.com"
          />
          <Submit busy={busy} busyLabel="Enviando…">Enviar link</Submit>
        </form>
      )}
    </div>
  )
}

function ResetForm() {
  const [params] = useSearchParams()
  const token = params.get('token') ?? ''
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState(null)

  async function submit(e) {
    e.preventDefault()
    setError(null)
    if (password.length < 10) return setError('A senha precisa ter pelo menos 10 caracteres.')
    setBusy(true)
    try {
      await publicPost('/auth/reset-password', { token, password })
      setDone(true)
    } catch (err) {
      setError(fieldErrors(err).password ?? err.message)
    } finally {
      setBusy(false)
    }
  }

  if (!token) {
    return (
      <div className="af-form">
        <h2 className="af-title">Link incompleto</h2>
        <FormAlert>Este link de redefinição está incompleto. Peça um novo na tela de entrar.</FormAlert>
        <Link to="/login" className="btn btn-glass btn-lg btn-block">Ir para entrar</Link>
      </div>
    )
  }
  return (
    <div className="af-form">
      <h2 className="af-title">Criar uma nova senha</h2>
      {done ? (
        <>
          <FormAlert tone="ok">Senha alterada. Por segurança, encerramos as outras sessões da sua conta.</FormAlert>
          <Link to="/login" className="btn btn-coin btn-lg btn-block">Entrar com a nova senha<ArrowRight size={18} weight="bold" /></Link>
        </>
      ) : (
        <form className="af-form" onSubmit={submit} noValidate aria-label="Nova senha">
          <FormAlert>{error}</FormAlert>
          <PasswordField
            label="Nova senha" name="new-password" autoComplete="new-password" required
            value={password} onChange={(e) => setPassword(e.target.value)}
            hint={<p className="af-hint">Pelo menos 10 caracteres.</p>}
          />
          <Submit busy={busy} busyLabel="Salvando…">Salvar nova senha</Submit>
        </form>
      )}
    </div>
  )
}

function VerifyEmail() {
  const [params] = useSearchParams()
  const token = params.get('token') ?? ''
  const { status } = useAuth()
  const [state, setState] = useState(token ? 'working' : 'error')
  const [message, setMessage] = useState(token ? '' : 'Este link de confirmação está incompleto.')
  const sent = useRef(false)

  useEffect(() => {
    // O token é de uso único: o StrictMode roda efeitos duas vezes em dev.
    if (!token || sent.current) return
    sent.current = true
    publicPost('/auth/verify-email', { token })
      .then(() => setState('ok'))
      .catch((err) => {
        setMessage(err.message)
        setState('error')
      })
  }, [token])

  const dest = status === 'authed' ? '/dashboard' : '/login'
  return (
    <div className="af-form" aria-live="polite">
      <h2 className="af-title">Confirmação de e-mail</h2>
      {state === 'working' && (
        <p className="af-sub af-working"><CircleNotch size={20} className="af-spin" aria-hidden="true" />Confirmando seu e-mail…</p>
      )}
      {state === 'ok' && (
        <>
          <FormAlert tone="ok">E-mail confirmado. Sua conta está pronta para entrar nas Vibes.</FormAlert>
          <Link to={dest} className="btn btn-coin btn-lg btn-block">
            {status === 'authed' ? 'Ir para minha conta' : 'Entrar'}<ArrowRight size={18} weight="bold" />
          </Link>
        </>
      )}
      {state === 'error' && (
        <>
          <FormAlert>{message} Você pode pedir um novo link na sua conta.</FormAlert>
          <Link to={dest} className="btn btn-glass btn-lg btn-block">Ir para minha conta</Link>
        </>
      )}
    </div>
  )
}

/* ---------------- Tela ---------------- */

const PROOF = [
  { Icon: Package, title: 'Lacrados', text: 'Novos, com garantia de fábrica' },
  { Icon: PixLogo, title: 'Pix ou cartão', text: 'Você escolhe como pagar o Get' },
  { Icon: Coins, title: <><span className="mono">40%</span> de volta</>, text: 'Em GetCoin, se você não vencer' },
]

export default function Auth({ view }) {
  const { status } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [params] = useSearchParams()
  const reduce = useReducedMotion()
  const [rising, setRising] = useState(false)
  const [forgot, setForgot] = useState(null) // e-mail pré-preenchido quando a recuperação está aberta
  const next = safeNext(params.get('next'))

  useEffect(() => setForgot(null), [view])

  const isTabs = view === 'login' || view === 'cadastro'
  const copy = COPY[isTabs ? view : 'conta']

  // Quem já está logado não precisa destas telas.
  if (isTabs && status === 'authed' && !rising) return <Navigate to={next} replace />

  // Assinatura: a GetCoin do horizonte sobe e acende antes de abrir a conta.
  function finish(state) {
    setRising(true)
    setTimeout(() => navigate(next, { replace: true, state }), reduce ? 0 : 700)
  }

  let panel
  if (view === 'login' && forgot !== null) panel = <ForgotForm initialEmail={forgot} onBack={() => setForgot(null)} />
  else if (view === 'login') panel = <LoginForm onDone={() => finish()} onForgot={(email) => setForgot(email)} />
  else if (view === 'cadastro') panel = <RegisterForm onDone={(s) => finish({ welcome: true, ...s })} />
  else if (view === 'redefinir') panel = <ResetForm />
  else panel = <VerifyEmail />

  const panelKey = view === 'login' && forgot !== null ? 'forgot' : view

  return (
    <MotionConfig reducedMotion="user">
      <div className={`auth ${rising ? 'is-rising' : ''}`}>
        <div className="auth-art" aria-hidden="true">
          <img src="/img/hero-bg.svg" alt="" />
        </div>

        <header className="auth-top">
          <Link to="/" className="auth-brand" aria-label="VibeGet, voltar ao início">
            <img src="/img/logo.png" alt="VibeGet" />
          </Link>
          <Link to="/" className="auth-home"><ArrowLeft size={16} aria-hidden="true" />Voltar ao site</Link>
        </header>

        <main className="auth-main">
          <section className="auth-copy" aria-labelledby="auth-title">
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={copy.title}
                initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.4, ease }}
              >
                <h1 id="auth-title" className="auth-title">{copy.title}</h1>
                <p className="auth-lede">{copy.lede}</p>
              </motion.div>
            </AnimatePresence>
            <ul className="auth-proof">
              {PROOF.map(({ Icon, title, text }) => (
                <li key={text}>
                  <span className="auth-proof-icon" aria-hidden="true"><Icon size={18} /></span>
                  <b className="auth-proof-title">{title}</b>
                  <span className="auth-proof-text">{text}</span>
                </li>
              ))}
            </ul>
          </section>

          <div className="auth-panel-wrap">
            <motion.div className="auth-panel glass" layout transition={{ duration: 0.45, ease }}>
              {isTabs && (
                <nav className="auth-tabs" aria-label="Acesso à conta">
                  {[['login', '/login', 'Entrar'], ['cadastro', '/cadastro', 'Criar conta']].map(([id, to, label]) => (
                    <Link
                      key={id}
                      to={{ pathname: to, search: location.search }}
                      className="auth-tab"
                      aria-current={view === id ? 'page' : undefined}
                    >
                      {view === id && (
                        <motion.span layoutId="auth-tab-pill" className="auth-tab-pill" transition={{ duration: 0.45, ease }} />
                      )}
                      <span className="auth-tab-label">{label}</span>
                    </Link>
                  ))}
                </nav>
              )}
              <AnimatePresence mode="wait" initial={false}>
                <motion.div
                  key={panelKey}
                  initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }}
                  transition={{ duration: 0.28, ease }}
                >
                  {panel}
                </motion.div>
              </AnimatePresence>
              <p className="auth-help">
                Precisa de ajuda? <a href="mailto:contato@leilaocash.com">contato@leilaocash.com</a>
              </p>
            </motion.div>
          </div>
        </main>
      </div>
    </MotionConfig>
  )
}
