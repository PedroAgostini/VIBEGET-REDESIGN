import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { CircleNotch, DownloadSimple, MapPin, SignOut, Trash, WarningCircle } from '@phosphor-icons/react'
import { api, deleteAccount, fieldErrors, logoutAll, updateUser } from '../../lib/api.js'
import { useAuth } from '../../lib/auth.jsx'
import { Field, FormAlert, PasswordField, Submit } from '../../components/form.jsx'
import { PageHead } from './ui.jsx'

const UFS = ['AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG', 'PA', 'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO']

const digits = (v) => v.replace(/\D/g, '')
const maskCep = (v) => digits(v).slice(0, 8).replace(/^(\d{5})(\d)/, '$1-$2')
const maskCpf = (v) => digits(v).slice(0, 11).replace(/^(\d{3})(\d)/, '$1.$2').replace(/^(\d{3})\.(\d{3})(\d)/, '$1.$2.$3').replace(/\.(\d{3})(\d)/, '.$1-$2')
const maskPhone = (v) => {
  const d = digits(v).slice(0, 11)
  if (d.length <= 2) return d
  if (d.length <= 6) return `(${d.slice(0, 2)}) ${d.slice(2)}`
  if (d.length <= 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`
  return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`
}
const userOf = (res) => res?.user ?? res?.data ?? null

/* ---------------- Dados ---------------- */

function ProfileForm({ me }) {
  const [values, setValues] = useState({
    name: me.name ?? '',
    phone: me.phone ? maskPhone(me.phone) : '',
    cpf: '',
    birthDate: me.birthDate ?? '',
  })
  const [errors, setErrors] = useState({})
  const [alert, setAlert] = useState(null)
  const [busy, setBusy] = useState(false)
  const set = (k, mask) => (e) => setValues((v) => ({ ...v, [k]: mask ? mask(e.target.value) : e.target.value }))

  async function submit(e) {
    e.preventDefault()
    setAlert(null)
    setErrors({})
    const body = {}
    if (values.name.trim() !== me.name) body.name = values.name.trim()
    if (values.phone && digits(values.phone) !== digits(me.phone ?? '')) body.phone = digits(values.phone)
    if (!me.hasCpf && values.cpf) body.cpf = digits(values.cpf)
    if (!me.birthDate && values.birthDate) body.birthDate = values.birthDate
    if (!Object.keys(body).length) return setAlert({ tone: 'ok', text: 'Nada mudou desde o último salvamento.' })
    setBusy(true)
    try {
      const res = await api('/me', { method: 'PATCH', body })
      const updated = userOf(res)
      if (updated?.email) updateUser(updated)
      setValues((v) => ({ ...v, cpf: '' }))
      setAlert({ tone: 'ok', text: 'Dados salvos.' })
    } catch (err) {
      const byField = fieldErrors(err)
      if (Object.keys(byField).length) setErrors(byField)
      else setAlert({ tone: 'error', text: err.message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="af-form dc-form" onSubmit={submit} noValidate aria-label="Dados do usuário">
      <FormAlert tone={alert?.tone}>{alert?.text}</FormAlert>
      <div className="dc-grid">
        <Field label="Nome completo" autoComplete="name" value={values.name} onChange={set('name')} error={errors.name} />
        <Field label="E-mail" type="email" value={me.email} readOnly hint="Para trocar o e-mail, fale com o suporte." />
        <Field label="Celular" type="tel" inputMode="tel" autoComplete="tel-national" placeholder="(11) 99999-9999" value={values.phone} onChange={set('phone', maskPhone)} error={errors.phone} />
        {me.hasCpf ? (
          <Field label="CPF" value={me.cpfMasked ?? '•••'} readOnly hint="O CPF não pode ser alterado depois de informado." />
        ) : (
          <Field label="CPF" inputMode="numeric" placeholder="000.000.000-00" value={values.cpf} onChange={set('cpf', maskCpf)} error={errors.cpf} hint="Necessário antes do primeiro Get. Depois de salvo, não pode ser alterado." />
        )}
        {me.birthDate ? (
          <Field label="Data de nascimento" value={me.birthDate.split('-').reverse().join('/')} readOnly />
        ) : (
          <Field label="Data de nascimento" type="date" autoComplete="bday" value={values.birthDate} onChange={set('birthDate')} error={errors.birthDate} hint="A participação é só para maiores de 18 anos." />
        )}
      </div>
      <div className="dc-actions"><Submit busy={busy} busyLabel="Salvando…">Salvar dados</Submit></div>
    </form>
  )
}

/* ---------------- Endereço ---------------- */

function AddressForm({ me }) {
  const a = me.address ?? {}
  const [values, setValues] = useState({
    cep: a.cep ? maskCep(a.cep) : '', street: a.street ?? '', number: a.number ?? '',
    complement: a.complement ?? '', district: a.district ?? '', city: a.city ?? '', state: a.state ?? '',
  })
  const [lookup, setLookup] = useState({ state: 'idle', message: '' })
  const [errors, setErrors] = useState({})
  const [alert, setAlert] = useState(null)
  const [busy, setBusy] = useState(false)
  const numberRef = useRef(null)
  const lastCep = useRef(a.cep ?? '')
  const set = (k) => (e) => setValues((v) => ({ ...v, [k]: e.target.value }))

  // Busca o CEP assim que os 8 dígitos são digitados; o foco vai para o número.
  useEffect(() => {
    const cep = digits(values.cep)
    if (cep.length !== 8 || cep === lastCep.current) return
    lastCep.current = cep
    let alive = true
    setLookup({ state: 'busy', message: '' })
    api(`/cep/${cep}`)
      .then((res) => {
        if (!alive) return
        const r = res?.data ?? res
        setValues((v) => ({ ...v, street: r.street ?? '', district: r.district ?? '', city: r.city ?? '', state: r.state ?? '' }))
        setLookup({ state: 'ok', message: '' })
        setTimeout(() => numberRef.current?.focus(), 0)
      })
      .catch((err) => {
        if (!alive) return
        lastCep.current = ''
        setLookup({ state: 'error', message: err.status === 404 ? 'CEP não encontrado. Confira o número ou preencha o endereço à mão.' : err.message })
      })
    return () => { alive = false }
  }, [values.cep])

  async function submit(e) {
    e.preventDefault()
    setAlert(null)
    const found = {}
    if (digits(values.cep).length !== 8) found.cep = 'Informe um CEP com 8 dígitos.'
    if (!values.street.trim()) found.street = 'Informe a rua.'
    if (!values.number.trim()) found.number = 'Informe o número.'
    if (!values.district.trim()) found.district = 'Informe o bairro.'
    if (!values.city.trim()) found.city = 'Informe a cidade.'
    if (!UFS.includes(values.state)) found.state = 'Escolha o estado.'
    setErrors(found)
    if (Object.keys(found).length) return
    setBusy(true)
    try {
      const body = Object.fromEntries(Object.entries({ ...values, cep: digits(values.cep) }).map(([k, v]) => [k, v.trim()]))
      if (!body.complement) delete body.complement
      const res = await api('/me/address', { method: 'PUT', body })
      const updated = userOf(res)
      if (updated?.email) updateUser(updated)
      setAlert({ tone: 'ok', text: 'Endereço salvo.' })
    } catch (err) {
      const byField = fieldErrors(err)
      if (Object.keys(byField).length) setErrors(byField)
      else setAlert({ tone: 'error', text: err.message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="af-form dc-form" onSubmit={submit} noValidate aria-label="Endereço">
      <FormAlert tone={alert?.tone}>{alert?.text}</FormAlert>
      <div className="dc-cep">
        <Field
          label="CEP" inputMode="numeric" autoComplete="postal-code" placeholder="00000-000"
          value={values.cep} onChange={(e) => setValues((v) => ({ ...v, cep: maskCep(e.target.value) }))}
          error={errors.cep || (lookup.state === 'error' ? lookup.message : undefined)}
          hint={lookup.state === 'busy' ? 'Buscando endereço…' : 'Digite o CEP e preenchemos o resto para você.'}
        />
        <span className="dc-cep-state" aria-hidden="true">
          {lookup.state === 'busy' ? <CircleNotch size={20} className="af-spin" /> : <MapPin size={20} />}
        </span>
      </div>
      <div className="dc-grid dc-grid-address">
        <Field label="Rua" autoComplete="address-line1" value={values.street} onChange={set('street')} error={errors.street} />
        <div className="af-field">
          <div className="af-label-row"><label htmlFor="dc-number">Número</label></div>
          <input
            id="dc-number" ref={numberRef} className="af-input" autoComplete="address-line2"
            value={values.number} onChange={set('number')} aria-invalid={errors.number ? 'true' : undefined}
          />
          {errors.number && <p className="af-error">{errors.number}</p>}
        </div>
        <Field label="Complemento" placeholder="Apto, bloco (opcional)" value={values.complement} onChange={set('complement')} error={errors.complement} />
        <Field label="Bairro" value={values.district} onChange={set('district')} error={errors.district} />
        <Field label="Cidade" autoComplete="address-level2" value={values.city} onChange={set('city')} error={errors.city} />
        <div className="af-field">
          <div className="af-label-row"><label htmlFor="dc-uf">Estado</label></div>
          <select id="dc-uf" className="af-input af-select" value={values.state} onChange={set('state')} aria-invalid={errors.state ? 'true' : undefined}>
            <option value="">UF</option>
            {UFS.map((uf) => <option key={uf} value={uf}>{uf}</option>)}
          </select>
          {errors.state && <p className="af-error">{errors.state}</p>}
        </div>
      </div>
      <div className="dc-actions"><Submit busy={busy} busyLabel="Salvando…">Salvar endereço</Submit></div>
    </form>
  )
}

/* ---------------- Senha ---------------- */

function PasswordForm({ email }) {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [errors, setErrors] = useState({})
  const [alert, setAlert] = useState(null)
  const [busy, setBusy] = useState(false)

  async function submit(e) {
    e.preventDefault()
    setAlert(null)
    const found = {}
    if (!current) found.currentPassword = 'Informe sua senha atual.'
    if (next.length < 10) found.newPassword = 'A nova senha precisa ter pelo menos 10 caracteres.'
    setErrors(found)
    if (Object.keys(found).length) return
    setBusy(true)
    try {
      await api('/auth/password', { method: 'PATCH', body: { currentPassword: current, newPassword: next } })
      setCurrent('')
      setNext('')
      setAlert({ tone: 'ok', text: 'Senha alterada. As outras sessões da sua conta foram encerradas.' })
    } catch (err) {
      const byField = fieldErrors(err)
      if (Object.keys(byField).length) setErrors(byField)
      else setAlert({ tone: 'error', text: err.message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="af-form dc-form" onSubmit={submit} noValidate aria-label="Alterar senha">
      <FormAlert tone={alert?.tone}>{alert?.text}</FormAlert>
      {/* Para o gerenciador de senhas associar a nova senha a esta conta */}
      <input className="af-hidden" type="email" autoComplete="username" value={email} readOnly tabIndex={-1} aria-hidden="true" />
      <div className="dc-grid">
        <PasswordField label="Senha atual" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} error={errors.currentPassword} />
        <PasswordField label="Nova senha" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} error={errors.newPassword} hint={<p className="af-hint">Pelo menos 10 caracteres.</p>} />
      </div>
      <div className="dc-actions"><Submit busy={busy} busyLabel="Alterando…">Alterar senha</Submit></div>
    </form>
  )
}

/* ---------------- Sessões ---------------- */

function SessionsSection() {
  const navigate = useNavigate()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  async function signOutEverywhere() {
    setBusy(true)
    setError(null)
    try {
      await logoutAll()
      navigate('/login', { replace: true })
    } catch (err) {
      setError(err.message)
      setBusy(false)
    }
  }

  return (
    <section className="dc-section glass" aria-labelledby="dc-sessions">
      <div className="dc-section-head">
        <h2 id="dc-sessions" className="dh-section-title">Sessões</h2>
        <p className="dh-text">Esqueceu a conta aberta em outro aparelho? Saia de todos de uma vez. Você vai precisar entrar de novo aqui também.</p>
      </div>
      <FormAlert>{error}</FormAlert>
      <div className="dc-row-actions">
        <button type="button" className="btn btn-glass" onClick={signOutEverywhere} disabled={busy}>
          {busy ? <CircleNotch size={18} className="af-spin" aria-hidden="true" /> : <SignOut size={18} aria-hidden="true" />}
          {busy ? 'Saindo…' : 'Sair de todos os dispositivos'}
        </button>
      </div>
    </section>
  )
}

/* ---------------- Privacidade (LGPD) ---------------- */

const BLOCKERS = {
  CASH_BALANCE: ['/dashboard/carteira?aba=saldo', 'Ir para o saldo em carteira'],
  MARKET_OPEN: ['/dashboard/marketplace?aba=vender', 'Ver meus anúncios'],
  OPEN_GETS: ['/dashboard/gets', 'Ver meus Gets'],
}

function PrivacySection({ email }) {
  const navigate = useNavigate()
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState(null)
  const [confirming, setConfirming] = useState(false)
  const [password, setPassword] = useState('')
  const [passError, setPassError] = useState(null)
  const [blocker, setBlocker] = useState(null)
  const [deleting, setDeleting] = useState(false)

  async function download() {
    setExporting(true)
    setExportError(null)
    try {
      const data = await api('/me/export')
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }))
      const a = document.createElement('a')
      a.href = url
      a.download = 'vibeget-meus-dados.json'
      a.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      setExportError(err.message)
    } finally {
      setExporting(false)
    }
  }

  async function remove(e) {
    e.preventDefault()
    setPassError(null)
    setBlocker(null)
    if (!password) return setPassError('Informe sua senha para confirmar.')
    setDeleting(true)
    try {
      await deleteAccount(password)
      navigate('/', { replace: true })
    } catch (err) {
      if (err.code === 'INVALID_PASSWORD') setPassError(err.message)
      else setBlocker({ message: err.message, link: BLOCKERS[err.code] })
      setDeleting(false)
    }
  }

  function cancel() {
    setConfirming(false)
    setPassword('')
    setPassError(null)
    setBlocker(null)
  }

  return (
    <section className="dc-section glass" aria-labelledby="dc-privacy">
      <div className="dc-section-head">
        <h2 id="dc-privacy" className="dh-section-title">Privacidade e dados</h2>
        <p className="dh-text">Pela LGPD, você pode baixar uma cópia de tudo o que guardamos sobre você ou excluir a sua conta.</p>
      </div>

      <div className="dc-privacy-row">
        <div>
          <p className="dc-privacy-title">Baixar meus dados</p>
          <p className="dc-privacy-copy">Um arquivo JSON com perfil, endereço, Gets, extratos, saques, compras e marketplace.</p>
        </div>
        <button type="button" className="btn btn-glass" onClick={download} disabled={exporting}>
          {exporting ? <CircleNotch size={18} className="af-spin" aria-hidden="true" /> : <DownloadSimple size={18} aria-hidden="true" />}
          {exporting ? 'Preparando…' : 'Baixar arquivo'}
        </button>
      </div>
      <FormAlert>{exportError}</FormAlert>

      <div className="dc-privacy-row">
        <div>
          <p className="dc-privacy-title">Excluir minha conta</p>
          <p className="dc-privacy-copy">Apaga seus dados pessoais e encerra o acesso. Não dá para desfazer.</p>
        </div>
        {!confirming && (
          <button type="button" className="btn btn-glass btn-danger" onClick={() => setConfirming(true)}>
            <Trash size={18} aria-hidden="true" />Excluir conta
          </button>
        )}
      </div>

      {confirming && (
        <form className="af-form dc-form dc-delete" onSubmit={remove} noValidate aria-label="Confirmar exclusão da conta">
          <ul className="dc-delete-list">
            <li>Nome, e-mail, CPF, celular e endereço são apagados, e você não consegue mais entrar.</li>
            <li>Seus GetCoins são perdidos. Saldo em R$ precisa ser sacado antes.</li>
            <li>Pagamentos e saques continuam registrados, sem os seus dados, por obrigação legal.</li>
          </ul>
          {blocker && (
            <div className="af-alert af-alert-error" role="alert">
              <WarningCircle size={20} weight="fill" aria-hidden="true" />
              <div>
                {blocker.message}
                {blocker.link && <> <Link to={blocker.link[0]} className="af-inline-link">{blocker.link[1]}</Link></>}
              </div>
            </div>
          )}
          <input className="af-hidden" type="email" autoComplete="username" value={email} readOnly tabIndex={-1} aria-hidden="true" />
          <div className="dc-delete-pass">
            <PasswordField label="Sua senha" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} error={passError} />
          </div>
          <div className="dc-row-actions">
            <button type="button" className="btn btn-glass" onClick={cancel} disabled={deleting}>Cancelar</button>
            <button type="submit" className="btn btn-glass btn-danger" disabled={deleting} aria-busy={deleting}>
              {deleting ? <CircleNotch size={18} className="af-spin" aria-hidden="true" /> : <Trash size={18} aria-hidden="true" />}
              {deleting ? 'Excluindo…' : 'Excluir definitivamente'}
            </button>
          </div>
        </form>
      )}
    </section>
  )
}

export default function Account() {
  const { user } = useAuth()
  if (!user) return null
  return (
    <div className="dp">
      <PageHead title="Minha conta" />
      <section className="dc-section glass" aria-labelledby="dc-data">
        <h2 id="dc-data" className="dh-section-title">Dados do usuário</h2>
        <ProfileForm key={user.id} me={user} />
      </section>
      <section className="dc-section glass" aria-labelledby="dc-address">
        <div className="dc-section-head">
          <h2 id="dc-address" className="dh-section-title">Endereço</h2>
          <p className="dh-text">Usado para entregar o produto quando você vencer uma Vibe.</p>
        </div>
        <AddressForm key={`${user.id}-addr`} me={user} />
      </section>
      <section className="dc-section glass" aria-labelledby="dc-pass">
        <h2 id="dc-pass" className="dh-section-title">Alterar senha</h2>
        <PasswordForm email={user.email} />
      </section>
      <SessionsSection />
      <PrivacySection email={user.email} />
    </div>
  )
}
