import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft, ArrowSquareOut, CheckCircle, Info } from '@phosphor-icons/react'
import { api, fieldErrors } from '../../lib/api.js'
import { useApi } from '../../lib/useApi.js'
import VibeCard, { CAT_LABEL } from '../../components/VibeCard.jsx'
import { Field, FormAlert, Submit } from '../../components/form.jsx'
import { LoadError, PageHead, Skeleton } from '../dashboard/ui.jsx'
import { ReadOnlyNote, useIsAdmin } from './ui.jsx'
import { Benefits, DAY, Photos, Specs, intOnly, maskBrl, parseBrl, slugify, toLocal } from './NewAuction.jsx'

const STATUS = { DRAFT: ['Rascunho', 'off'], SCHEDULED: ['Agendada', 'wait'], LIVE: ['Ao vivo', 'lead'], ENDED: ['Encerrada', 'off'], CANCELLED: ['Cancelada', 'off'] }
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

/** O que pode mudar em cada situação (as mesmas travas da API). */
function locksFor(status) {
  if (status === 'LIVE') return { vibe: true, live: true, note: 'Com a Vibe ao vivo, da disputa só mudam o fim e a meta de Gets. O produto pode ser corrigido normalmente.' }
  if (status === 'ENDED' || status === 'CANCELLED') return { vibe: true, finished: true, note: 'Esta Vibe já terminou: só o produto pode ser corrigido (fotos, textos, ficha técnica).' }
  return { vibe: false, note: null }
}

function EditForm({ data, onSaved }) {
  const p = data.product
  const locks = locksFor(data.status)
  const initialPhotos = p.images?.length ? p.images : p.imageUrl ? [p.imageUrl] : []
  const initial = {
    name: p.name, category: p.category, brand: p.brand ?? '', model: p.model ?? '', price: maskBrl(String(p.originalPriceCents)),
    description: p.description ?? '', photos: initialPhotos, specs: p.specs ?? [],
    slug: data.slug, startsAt: toLocal(new Date(data.startsAt)), endsAt: toLocal(new Date(data.endsAt)),
    minGet: maskBrl(String(data.minGetCents)), goal: data.goalGets ? String(data.goalGets) : '', cashback: String(data.cashbackPercent), benefits: data.benefits ?? [],
  }
  const [v, setV] = useState(initial)
  const [errors, setErrors] = useState({})
  const [alert, setAlert] = useState(null)
  const [busy, setBusy] = useState(false)
  // Aceita valor ou função (Photos e Specs atualizam com função).
  const set = (key) => (value) => setV((s) => ({ ...s, [key]: typeof value === 'function' ? value(s[key]) : value }))

  const start = new Date(v.startsAt)
  const end = new Date(v.endsAt)
  const cleanSpecs = v.specs.filter((s) => s.label.trim() && s.value.trim()).map((s) => ({ label: s.label.trim(), value: s.value.trim() }))

  // Só vai para a API o que mudou em relação ao que veio dela.
  const productPatch = {}
  if (v.name.trim() !== p.name) productPatch.name = v.name.trim()
  if (v.category !== p.category) productPatch.category = v.category
  if ((v.brand.trim() || null) !== (p.brand ?? null)) productPatch.brand = v.brand.trim() || null
  if ((v.model.trim() || null) !== (p.model ?? null)) productPatch.model = v.model.trim() || null
  if (parseBrl(v.price) !== p.originalPriceCents) productPatch.originalPriceCents = parseBrl(v.price)
  if ((v.description.trim() || null) !== (p.description ?? null)) productPatch.description = v.description.trim() || null
  if (!same(v.photos, initialPhotos)) { productPatch.images = v.photos; productPatch.imageUrl = v.photos[0] ?? null }
  if (!same(cleanSpecs, p.specs ?? [])) productPatch.specs = cleanSpecs

  const vibePatch = {}
  if (!locks.finished) {
    if (v.endsAt !== initial.endsAt) vibePatch.endsAt = end.toISOString()
    if (v.goal !== initial.goal) vibePatch.goalGets = v.goal ? parseInt(v.goal, 10) : null
  }
  if (!locks.vibe) {
    if (v.slug !== data.slug) vibePatch.slug = v.slug
    if (v.startsAt !== initial.startsAt) vibePatch.startsAt = start.toISOString()
    if (parseBrl(v.minGet) !== data.minGetCents) vibePatch.minGetCents = parseBrl(v.minGet)
    if (v.cashback !== initial.cashback && v.cashback !== '') vibePatch.cashbackPercent = Math.min(100, parseInt(v.cashback, 10))
    if (!same(v.benefits, data.benefits ?? [])) vibePatch.benefits = v.benefits
  }
  const changes = Object.keys(productPatch).length + Object.keys(vibePatch).length

  const preview = {
    id: 'preview', slug: v.slug, status: data.status === 'DRAFT' ? 'SCHEDULED' : data.status,
    startsAt: start.toISOString(), endsAt: end.toISOString(), getsCloseAt: data.getsCloseAt ?? end.toISOString(),
    minGetCents: parseBrl(v.minGet), goalGets: v.goal ? parseInt(v.goal, 10) : null, confirmedGets: data.confirmedGets, topGet: data.topGet,
    product: { name: v.name || 'Nome do produto', category: v.category, imageUrl: v.photos[0] ?? null, originalPriceCents: parseBrl(v.price) || null },
  }

  async function submit(e) {
    e.preventDefault()
    setAlert(null)
    const found = {}
    if (v.name.trim().length < 2) found['product.name'] = 'Informe o nome do produto.'
    if (!parseBrl(v.price)) found['product.originalPriceCents'] = 'Informe o preço na loja.'
    if (!locks.vibe) {
      if (!v.slug) found['vibe.slug'] = 'Informe o endereço da página.'
      if (!parseBrl(v.minGet)) found['vibe.minGetCents'] = 'Informe o Get mínimo.'
    }
    if (vibePatch.endsAt || vibePatch.startsAt) {
      if (!(end > start)) found['vibe.endsAt'] = 'O fim precisa ser depois do início.'
      else if (end - start > 15 * DAY) found['vibe.endsAt'] = 'Uma Vibe dura no máximo 15 dias desde o início.'
      else if (data.status !== 'DRAFT' && end <= new Date()) found['vibe.endsAt'] = 'O fim precisa estar no futuro. Para encerrar agora, use "Encerrar agora" na lista.'
    }
    setErrors(found)
    if (Object.keys(found).length) { setAlert('Confira os campos marcados.'); return }
    if (!changes) return

    setBusy(true)
    const done = []
    try {
      if (Object.keys(productPatch).length) {
        try {
          await api(`/admin/products/${p.id}`, { method: 'PATCH', body: productPatch })
          done.push('produto')
        } catch (err) { err.prefix = 'product'; throw err }
      }
      if (Object.keys(vibePatch).length) {
        try {
          await api(`/admin/vibes/${data.id}`, { method: 'PATCH', body: vibePatch })
        } catch (err) { err.prefix = 'vibe'; throw err }
      }
      onSaved()
    } catch (err) {
      const byField = Object.fromEntries(Object.entries(fieldErrors(err)).map(([k, m]) => [`${err.prefix}.${k}`, m]))
      if (err.code === 'SLUG_TAKEN') byField['vibe.slug'] = 'Esse endereço já é usado por outra Vibe. Escolha outro.'
      if (Object.keys(byField).length) setErrors(byField)
      // Produto salvo e disputa recusada: avisa; salvar de novo só reenvia o mesmo produto (sem efeito).
      const partial = done.length ? ' As mudanças do produto já foram salvas.' : ''
      setAlert(`${Object.keys(byField).length ? 'Confira os campos marcados.' : err.message}${partial}`)
      setBusy(false)
    }
  }

  return (
    <form className="na" onSubmit={submit} noValidate aria-label="Editar leilão">
      <div className="na-main">
        <FormAlert>{alert}</FormAlert>

        <section className="dc-section glass" aria-labelledby="ea-prod">
          <h2 id="ea-prod" className="dh-section-title">Produto</h2>
          {data.productVibesCount > 1 && (
            <p className="ea-note"><Info size={16} aria-hidden="true" />Este produto está em {data.productVibesCount} Vibes: o que mudar aqui aparece em todas.</p>
          )}
          <div className="dc-grid">
            <Field label="Nome do produto" value={v.name} onChange={(e) => set('name')(e.target.value)} error={errors['product.name']} maxLength={160} />
            <div className="af-field">
              <div className="af-label-row"><label htmlFor="ea-cat">Categoria</label></div>
              <select id="ea-cat" className="af-input af-select" value={v.category} onChange={(e) => set('category')(e.target.value)}>
                {Object.entries(CAT_LABEL).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
              </select>
            </div>
            <Field label="Marca" value={v.brand} onChange={(e) => set('brand')(e.target.value)} error={errors['product.brand']} maxLength={80} />
            <Field label="Modelo" value={v.model} onChange={(e) => set('model')(e.target.value)} error={errors['product.model']} maxLength={120} />
            <Field label="Preço na loja (R$)" inputMode="numeric" value={v.price} onChange={(e) => set('price')(maskBrl(e.target.value))} error={errors['product.originalPriceCents']} hint="Mostrado riscado, para comparar com o Get." />
          </div>
          <div className="af-field">
            <div className="af-label-row"><label htmlFor="ea-desc">Descrição</label></div>
            <textarea id="ea-desc" className="af-input na-textarea" rows={4} maxLength={5000} value={v.description} onChange={(e) => set('description')(e.target.value)} />
          </div>
        </section>

        <section className="dc-section glass" aria-labelledby="ea-photos">
          <h2 id="ea-photos" className="dh-section-title">Fotos</h2>
          <Photos photos={v.photos} setPhotos={set('photos')} />
          {errors['product.images'] && <p className="af-error">{errors['product.images']}</p>}
        </section>

        <section className="dc-section glass" aria-labelledby="ea-specs">
          <h2 id="ea-specs" className="dh-section-title">Ficha técnica</h2>
          <Specs specs={v.specs} setSpecs={set('specs')} />
        </section>

        <section className="dc-section glass" aria-labelledby="ea-vibe">
          <h2 id="ea-vibe" className="dh-section-title">Disputa</h2>
          {locks.note && <p className="ea-note"><Info size={16} aria-hidden="true" />{locks.note}</p>}
          <div className="dc-grid">
            <Field label="Início" type="datetime-local" value={v.startsAt} onChange={(e) => set('startsAt')(e.target.value)} error={errors['vibe.startsAt']} disabled={locks.vibe} />
            <div className="na-end">
              <Field label="Fim" type="datetime-local" value={v.endsAt} onChange={(e) => set('endsAt')(e.target.value)} error={errors['vibe.endsAt']} disabled={locks.finished} hint="No máximo 15 dias depois do início." />
              {!locks.finished && (
                <div className="vd-quick" role="group" aria-label="Duração rápida">
                  {[3, 7, 15].map((d) => (
                    <button key={d} type="button" className="vd-quick-btn" onClick={() => set('endsAt')(toLocal(new Date(start.getTime() + d * DAY)))}>{d} dias</button>
                  ))}
                </div>
              )}
            </div>
            <Field label="Get mínimo (R$)" inputMode="numeric" value={v.minGet} onChange={(e) => set('minGet')(maskBrl(e.target.value))} error={errors['vibe.minGetCents']} disabled={locks.vibe} />
            <Field label="Meta de Gets (opcional)" inputMode="numeric" value={v.goal} onChange={(e) => set('goal')(intOnly(e.target.value))} error={errors['vibe.goalGets']} disabled={locks.finished} hint="Só informativa: não encerra a Vibe." />
            <Field label="Cashback para quem não vence (%)" inputMode="numeric" value={v.cashback} onChange={(e) => set('cashback')(e.target.value.replace(/\D/g, '').slice(0, 3))} error={errors['vibe.cashbackPercent']} disabled={locks.vibe} />
            <Field label="Endereço da página" value={v.slug} onChange={(e) => set('slug')(slugify(e.target.value))} error={errors['vibe.slug']} disabled={locks.vibe} hint={`/vibes/${v.slug || '…'}`} />
          </div>
          {!locks.vibe && (
            <div className="af-field">
              <div className="af-label-row"><span className="na-label">Benefícios extras</span></div>
              <Benefits items={v.benefits} setItems={set('benefits')} />
            </div>
          )}
        </section>

        <div className="dc-actions ea-actions">
          <span className="ea-count">{changes ? `${changes} ${changes === 1 ? 'alteração' : 'alterações'} para salvar` : 'Nada alterado ainda'}</span>
          <Submit busy={busy} busyLabel="Salvando…" disabled={!changes}>Salvar alterações</Submit>
        </div>
      </div>

      <aside className="na-side" aria-label="Prévia do cartão">
        <p className="na-side-title">Prévia na vitrine</p>
        <div className="na-preview"><VibeCard v={preview} now={Date.now()} /></div>
      </aside>
    </form>
  )
}

export default function EditAuction() {
  const { id } = useParams()
  const isAdmin = useIsAdmin()
  const res = useApi(`/admin/vibes/${id}`)
  const [savedAt, setSavedAt] = useState(null)
  const data = res.data?.data
  const back = <Link to="/admin/vibes" className="ad-site-link"><ArrowLeft size={16} aria-hidden="true" />Voltar para Vibes</Link>

  if (!isAdmin) return <div className="dp"><PageHead title="Editar leilão">{back}</PageHead><ReadOnlyNote /></div>
  if (res.error) return <div className="dp"><PageHead title="Editar leilão">{back}</PageHead><LoadError message={res.error} onRetry={res.reload} /></div>
  if (!data) return <div className="dp"><PageHead title="Editar leilão">{back}</PageHead><Skeleton lines={8} /></div>

  const [label, tone] = STATUS[data.status] ?? [data.status, 'off']
  const showPage = data.status !== 'DRAFT' && data.status !== 'CANCELLED'

  return (
    <div className="dp">
      <PageHead title="Editar leilão">{back}</PageHead>
      <div className="ea-head">
        <span className={`dg-pill dg-pill-${tone}`}>{label}</span>
        <span className="ad-who-meta"><span className="mono">{data.confirmedGets}</span> {data.confirmedGets === 1 ? 'Get confirmado' : 'Gets confirmados'}</span>
        {showPage && <a className="ad-vibe-link ea-page" href={`/vibes/${data.slug}`} target="_blank" rel="noreferrer">Ver página<ArrowSquareOut size={14} aria-hidden="true" /></a>}
      </div>
      {savedAt && <p className="ea-saved" role="status"><CheckCircle size={18} weight="fill" aria-hidden="true" />Alterações salvas às {new Date(savedAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}.</p>}
      {/* A chave muda quando a API devolve dados novos: o formulário recomeça a partir do que foi salvo. */}
      <EditForm key={`${data.updatedAt}-${data.product.updatedAt}`} data={data} onSaved={() => { setSavedAt(Date.now()); res.reload() }} />
    </div>
  )
}
