import { useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft, ArrowSquareOut, CircleNotch, ImageSquare, Plus, Star, Trash, UploadSimple, X } from '@phosphor-icons/react'
import { api, fieldErrors, upload } from '../../lib/api.js'
import { useApi } from '../../lib/useApi.js'
import VibeCard, { CAT_LABEL } from '../../components/VibeCard.jsx'
import { Field, FormAlert, Submit } from '../../components/form.jsx'
import { PageHead } from '../dashboard/ui.jsx'
import { ReadOnlyNote, useIsAdmin } from './ui.jsx'

export const DAY = 24 * 3600 * 1000
const MAX_PHOTOS = 10
const MAX_BYTES = 5_000_000
const STATUSES = [
  ['LIVE', 'Ao vivo agora', 'Abre para Gets assim que salvar.'],
  ['SCHEDULED', 'Agendada', 'Aparece como "em breve" e abre sozinha no início.'],
  ['DRAFT', 'Rascunho', 'Fica escondida do site até você publicar.'],
]

export const slugify = (s) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120)
const pad = (n) => String(n).padStart(2, '0')
export const toLocal = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
export const parseBrl = (v) => {
  const d = String(v).replace(/\D/g, '')
  return d ? parseInt(d, 10) : 0
}
export const maskBrl = (v) => {
  const c = parseBrl(v)
  return c ? (c / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 }) : ''
}
export const intOnly = (v) => v.replace(/\D/g, '').slice(0, 7)

export function Photos({ photos, setPhotos }) {
  const input = useRef(null)
  const [busy, setBusy] = useState(0)
  const [error, setError] = useState(null)

  async function add(files) {
    setError(null)
    const list = [...files].slice(0, MAX_PHOTOS - photos.length)
    for (const f of list) {
      if (!/^image\/(jpeg|png|webp)$/.test(f.type)) { setError(`${f.name}: use JPG, PNG ou WebP.`); continue }
      if (f.size > MAX_BYTES) { setError(`${f.name}: a foto passa de 5 MB.`); continue }
      setBusy((n) => n + 1)
      try {
        const res = await upload('/admin/uploads', f)
        setPhotos((p) => [...p, res.data.url].slice(0, MAX_PHOTOS))
      } catch (err) {
        setError(`${f.name}: ${err.message}`)
      } finally {
        setBusy((n) => n - 1)
      }
    }
    if (input.current) input.current.value = ''
  }

  return (
    <div className="na-photos">
      <ul className="na-photo-list">
        {photos.map((url, i) => (
          <li key={url} className={`na-photo ${i === 0 ? 'is-cover' : ''}`}>
            <img src={url} alt="" />
            {i === 0 ? <span className="na-cover-tag">Capa</span> : (
              <button type="button" className="na-photo-btn na-photo-cover" onClick={() => setPhotos((p) => [url, ...p.filter((x) => x !== url)])} aria-label="Usar como capa">
                <Star size={14} weight="fill" aria-hidden="true" />
              </button>
            )}
            <button type="button" className="na-photo-btn na-photo-del" onClick={() => setPhotos((p) => p.filter((x) => x !== url))} aria-label="Remover foto">
              <X size={14} weight="bold" aria-hidden="true" />
            </button>
          </li>
        ))}
        {Array.from({ length: busy }, (_, i) => (
          <li key={`busy-${i}`} className="na-photo is-busy"><CircleNotch size={22} className="af-spin" aria-label="Enviando foto" /></li>
        ))}
        {photos.length + busy < MAX_PHOTOS && (
          <li>
            <button type="button" className="na-photo-add" onClick={() => input.current?.click()}>
              <UploadSimple size={22} aria-hidden="true" />
              <span>{photos.length ? 'Adicionar' : 'Enviar fotos'}</span>
            </button>
          </li>
        )}
      </ul>
      <input ref={input} type="file" accept="image/jpeg,image/png,image/webp" multiple hidden onChange={(e) => add(e.target.files)} />
      <p className="af-hint">JPG, PNG ou WebP até 5 MB, no máximo {MAX_PHOTOS}. Prefira fundo branco: a foto entra no pedestal creme. A primeira é a capa.</p>
      {error && <p className="af-error" role="alert">{error}</p>}
    </div>
  )
}

export function Specs({ specs, setSpecs }) {
  const set = (i, k) => (e) => setSpecs((s) => s.map((row, j) => (j === i ? { ...row, [k]: e.target.value } : row)))
  return (
    <div className="na-specs">
      {specs.map((row, i) => (
        <div key={i} className="na-spec-row">
          <input className="af-input" placeholder="Item (ex.: Tela)" aria-label={`Item ${i + 1} da ficha técnica`} value={row.label} onChange={set(i, 'label')} maxLength={60} />
          <input className="af-input" placeholder="Valor (ex.: 6,7 polegadas)" aria-label={`Valor ${i + 1} da ficha técnica`} value={row.value} onChange={set(i, 'value')} maxLength={200} />
          <button type="button" className="na-icon-btn" onClick={() => setSpecs((s) => s.filter((_, j) => j !== i))} aria-label="Remover linha"><Trash size={16} aria-hidden="true" /></button>
        </div>
      ))}
      {specs.length < 40 && (
        <button type="button" className="btn btn-sm btn-glass na-add" onClick={() => setSpecs((s) => [...s, { label: '', value: '' }])}><Plus size={16} aria-hidden="true" />Adicionar linha</button>
      )}
    </div>
  )
}

export function Benefits({ items, setItems }) {
  const [text, setText] = useState('')
  const add = () => {
    const t = text.trim()
    if (t.length < 3 || items.length >= 8 || items.includes(t)) return
    setItems([...items, t])
    setText('')
  }
  return (
    <div className="na-benefits">
      <div className="na-benefit-add">
        <input
          className="af-input" placeholder="Ex.: Nota fiscal no nome do vencedor" maxLength={80} value={text} aria-label="Novo benefício"
          onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add() } }}
        />
        <button type="button" className="btn btn-sm btn-glass" onClick={add} disabled={text.trim().length < 3 || items.length >= 8}>Adicionar</button>
      </div>
      {items.length > 0 && (
        <ul className="na-tags">
          {items.map((b) => (
            <li key={b}>{b}<button type="button" onClick={() => setItems(items.filter((x) => x !== b))} aria-label={`Remover ${b}`}><X size={12} weight="bold" aria-hidden="true" /></button></li>
          ))}
        </ul>
      )}
      <p className="af-hint">Até 8. Os benefícios fixos da plataforma (lacrado, garantia, frete) já aparecem em toda Vibe.</p>
    </div>
  )
}

export default function NewAuction() {
  const isAdmin = useIsAdmin()
  const settings = useApi(isAdmin ? '/admin/settings' : null)
  const defaultCashback = settings.data?.data?.defaultCashbackPercent ?? 40
  const now = Date.now()

  const [name, setName] = useState('')
  const [category, setCategory] = useState('smartphones')
  const [brand, setBrand] = useState('')
  const [model, setModel] = useState('')
  const [price, setPrice] = useState('')
  const [description, setDescription] = useState('')
  const [photos, setPhotos] = useState([])
  const [specs, setSpecs] = useState([])
  const [slug, setSlug] = useState('')
  const [slugTouched, setSlugTouched] = useState(false)
  const [status, setStatus] = useState('LIVE')
  const [startsAt, setStartsAt] = useState(toLocal(new Date(now + DAY)))
  const [endsAt, setEndsAt] = useState(toLocal(new Date(now + 7 * DAY)))
  const [minGet, setMinGet] = useState('3,95')
  const [goal, setGoal] = useState('')
  const [cashback, setCashback] = useState('')
  const [benefits, setBenefits] = useState([])
  const [errors, setErrors] = useState({})
  const [alert, setAlert] = useState(null)
  const [busy, setBusy] = useState(false)
  const [created, setCreated] = useState(null)

  const finalSlug = slugTouched ? slug : slugify(name)
  const start = status === 'LIVE' ? new Date() : new Date(startsAt)
  const end = new Date(endsAt)
  const setDuration = (days) => setEndsAt(toLocal(new Date((status === 'LIVE' ? Date.now() : new Date(startsAt).getTime()) + days * DAY)))

  const preview = {
    id: 'preview', slug: finalSlug || 'nova-vibe', status: status === 'DRAFT' ? 'SCHEDULED' : status,
    startsAt: start.toISOString(), endsAt: end.toISOString(), getsCloseAt: end.toISOString(),
    minGetCents: parseBrl(minGet), goalGets: goal ? parseInt(goal, 10) : null, confirmedGets: 0, topGet: null,
    product: { name: name || 'Nome do produto', category, imageUrl: photos[0] ?? null, originalPriceCents: parseBrl(price) || null },
  }

  async function submit(e) {
    e.preventDefault()
    setAlert(null)
    const found = {}
    if (name.trim().length < 2) found['product.name'] = 'Informe o nome do produto.'
    if (!parseBrl(price)) found['product.originalPriceCents'] = 'Informe o preço na loja.'
    if (!finalSlug) found['vibe.slug'] = 'Informe o endereço da página.'
    if (!parseBrl(minGet)) found['vibe.minGetCents'] = 'Informe o Get mínimo.'
    if (!(end > start)) found['vibe.endsAt'] = 'O fim precisa ser depois do início.'
    else if (end - start > 15 * DAY) found['vibe.endsAt'] = 'Uma Vibe dura no máximo 15 dias.'
    else if (status !== 'DRAFT' && end <= new Date()) found['vibe.endsAt'] = 'O fim precisa estar no futuro.'
    if (status === 'SCHEDULED' && start <= new Date()) found['vibe.startsAt'] = 'Para agendar, o início precisa estar no futuro.'
    const cleanSpecs = specs.filter((s) => s.label.trim() && s.value.trim()).map((s) => ({ label: s.label.trim(), value: s.value.trim() }))
    setErrors(found)
    if (Object.keys(found).length) {
      setAlert('Confira os campos marcados.')
      return
    }
    const body = {
      product: {
        slug: finalSlug, name: name.trim(), category, originalPriceCents: parseBrl(price),
        imageUrl: photos[0] ?? null, images: photos,
        description: description.trim() || null, brand: brand.trim() || null, model: model.trim() || null, specs: cleanSpecs,
      },
      vibe: {
        slug: finalSlug, status, minGetCents: parseBrl(minGet), startsAt: start.toISOString(), endsAt: end.toISOString(),
        goalGets: goal ? parseInt(goal, 10) : null, benefits,
        ...(cashback !== '' ? { cashbackPercent: Math.min(100, parseInt(cashback, 10)) } : {}),
      },
    }
    setBusy(true)
    try {
      const res = await api('/admin/auctions', { method: 'POST', body })
      setCreated(res.data)
      window.scrollTo({ top: 0 })
    } catch (err) {
      const byField = fieldErrors(err)
      if (Object.keys(byField).length) {
        setErrors(byField)
        setAlert('Confira os campos marcados.')
      } else setAlert(err.status === 409 ? `${err.message} Troque o endereço da página.` : err.message)
    } finally {
      setBusy(false)
    }
  }

  if (!isAdmin) {
    return <div className="dp"><PageHead title="Novo leilão" /><ReadOnlyNote /></div>
  }

  if (created) {
    const v = created.vibe
    return (
      <div className="dp">
        <PageHead title="Leilão criado" />
        <section className="dg-onboarding glass">
          <ImageSquare size={34} weight="duotone" aria-hidden="true" />
          <div className="dg-onboarding-copy">
            <h2 className="dh-section-title">{created.product.name}</h2>
            <p className="dh-text">
              {v.status === 'LIVE' ? 'A Vibe já está aberta para Gets.' : v.status === 'SCHEDULED' ? 'A Vibe abre sozinha no horário de início.' : 'A Vibe foi salva como rascunho e não aparece no site.'}
            </p>
          </div>
          <div className="na-done-actions">
            {v.status !== 'DRAFT' && <a className="btn btn-glass" href={`/vibes/${v.slug}`} target="_blank" rel="noreferrer">Ver página<ArrowSquareOut size={16} aria-hidden="true" /></a>}
            <button type="button" className="btn btn-coin" onClick={() => window.location.reload()}>Cadastrar outro</button>
          </div>
        </section>
        <Link to={`/admin/vibes?status=${v.status}`} className="af-inline-link">Ir para a lista de Vibes</Link>
      </div>
    )
  }

  return (
    <div className="dp">
      <PageHead title="Novo leilão">
        <Link to="/admin/vibes" className="ad-site-link"><ArrowLeft size={16} aria-hidden="true" />Voltar para Vibes</Link>
      </PageHead>

      <form className="na" onSubmit={submit} noValidate aria-label="Cadastro de leilão">
        <div className="na-main">
          <FormAlert>{alert}</FormAlert>

          <section className="dc-section glass" aria-labelledby="na-prod">
            <h2 id="na-prod" className="dh-section-title">Produto</h2>
            <div className="dc-grid">
              <Field label="Nome do produto" value={name} onChange={(e) => setName(e.target.value)} error={errors['product.name']} placeholder="Ex.: iPhone 15 Pro Max 256GB" maxLength={160} />
              <div className="af-field">
                <div className="af-label-row"><label htmlFor="na-cat">Categoria</label></div>
                <select id="na-cat" className="af-input af-select" value={category} onChange={(e) => setCategory(e.target.value)}>
                  {Object.entries(CAT_LABEL).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
                </select>
              </div>
              <Field label="Marca" value={brand} onChange={(e) => setBrand(e.target.value)} placeholder="Ex.: Apple" maxLength={80} />
              <Field label="Modelo" value={model} onChange={(e) => setModel(e.target.value)} placeholder="Ex.: A3106" maxLength={120} />
              <Field label="Preço na loja (R$)" inputMode="numeric" placeholder="0,00" value={price} onChange={(e) => setPrice(maskBrl(e.target.value))} error={errors['product.originalPriceCents']} hint="Mostrado riscado, para comparar com o Get." />
            </div>
            <div className="af-field">
              <div className="af-label-row"><label htmlFor="na-desc">Descrição</label></div>
              <textarea id="na-desc" className="af-input na-textarea" rows={4} maxLength={5000} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="O que vem na caixa, estado (lacrado), garantia…" />
            </div>
          </section>

          <section className="dc-section glass" aria-labelledby="na-photos">
            <h2 id="na-photos" className="dh-section-title">Fotos</h2>
            <Photos photos={photos} setPhotos={setPhotos} />
          </section>

          <section className="dc-section glass" aria-labelledby="na-specs">
            <div className="dc-section-head">
              <h2 id="na-specs" className="dh-section-title">Ficha técnica</h2>
              <p className="dh-text">Opcional. Aparece em tabela na página da Vibe.</p>
            </div>
            <Specs specs={specs} setSpecs={setSpecs} />
          </section>

          <section className="dc-section glass" aria-labelledby="na-vibe">
            <h2 id="na-vibe" className="dh-section-title">Disputa</h2>
            <fieldset className="na-status">
              <legend className="dw-legend">Situação</legend>
              <div className="na-status-row">
                {STATUSES.map(([id, label, help]) => (
                  <label key={id} className={`na-status-opt ${status === id ? 'is-on' : ''}`}>
                    <input type="radio" name="na-status" value={id} checked={status === id} onChange={() => setStatus(id)} />
                    <span className="na-status-label">{label}</span>
                    <span className="na-status-help">{help}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="dc-grid">
              {status !== 'LIVE' ? (
                <Field label="Início" type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} error={errors['vibe.startsAt']} />
              ) : (
                <Field label="Início" value="Agora, ao salvar" readOnly />
              )}
              <div className="na-end">
                <Field label="Fim" type="datetime-local" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} error={errors['vibe.endsAt']} hint="No máximo 15 dias depois do início." />
                <div className="vd-quick" role="group" aria-label="Duração rápida">
                  {[3, 7, 15].map((d) => <button key={d} type="button" className="vd-quick-btn" onClick={() => setDuration(d)}>{d} dias</button>)}
                </div>
              </div>
              <Field label="Get mínimo (R$)" inputMode="numeric" value={minGet} onChange={(e) => setMinGet(maskBrl(e.target.value))} error={errors['vibe.minGetCents']} />
              <Field label="Meta de Gets (opcional)" inputMode="numeric" placeholder="Ex.: 480" value={goal} onChange={(e) => setGoal(intOnly(e.target.value))} hint="Só informativa: não encerra a Vibe." />
              <Field label="Cashback para quem não vence (%)" inputMode="numeric" placeholder={String(defaultCashback)} value={cashback} onChange={(e) => setCashback(e.target.value.replace(/\D/g, '').slice(0, 3))} hint={`Vazio usa o padrão das configurações (${defaultCashback}%).`} />
              <Field
                label="Endereço da página" value={finalSlug} onChange={(e) => { setSlugTouched(true); setSlug(slugify(e.target.value)) }}
                error={errors['vibe.slug'] || errors['product.slug']} hint={`/vibes/${finalSlug || '…'}`}
              />
            </div>
            <div className="af-field">
              <div className="af-label-row"><span className="na-label">Benefícios extras</span></div>
              <Benefits items={benefits} setItems={setBenefits} />
            </div>
          </section>

          <div className="dc-actions"><Submit busy={busy} busyLabel="Salvando…">{status === 'DRAFT' ? 'Salvar rascunho' : status === 'SCHEDULED' ? 'Agendar Vibe' : 'Publicar Vibe'}</Submit></div>
        </div>

        <aside className="na-side" aria-label="Prévia do cartão">
          <p className="na-side-title">Prévia na vitrine</p>
          <div className="na-preview"><VibeCard v={preview} now={Date.now()} /></div>
          {status === 'DRAFT' && <p className="af-hint">Rascunho não aparece no site; a prévia mostra como ficará depois.</p>}
        </aside>
      </form>
    </div>
  )
}
