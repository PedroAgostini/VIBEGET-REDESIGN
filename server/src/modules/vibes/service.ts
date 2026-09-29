import { and, asc, count, desc, eq, ilike, inArray, sql, type SQL } from 'drizzle-orm'
import type { DbOrTx } from '../../db/client.js'
import { favorites, gets, products, users, vibes, vibeViews } from '../../db/schema.js'
import { notFound } from '../../lib/errors.js'
import { escapeLike, offsetOf, paginated, type Pagination } from '../../lib/pagination.js'
import { publicName } from '../../lib/presenters.js'

export const PUBLIC_STATUSES = ['SCHEDULED', 'LIVE', 'ENDED'] as const
export type PublicStatus = (typeof PUBLIC_STATUSES)[number]
export type Category = (typeof products.category.enumValues)[number]

const vibeWithProduct = {
  id: vibes.id,
  slug: vibes.slug,
  status: vibes.status,
  minGetCents: vibes.minGetCents,
  startsAt: vibes.startsAt,
  endsAt: vibes.endsAt,
  goalGets: vibes.goalGets,
  cashbackPercent: vibes.cashbackPercent,
  winnerGetId: vibes.winnerGetId,
  settledAt: vibes.settledAt,
  createdAt: vibes.createdAt,
  product: {
    id: products.id,
    slug: products.slug,
    name: products.name,
    category: products.category,
    imageUrl: products.imageUrl,
    originalPriceCents: products.originalPriceCents,
    description: products.description,
  },
}

/** Estatísticas públicas por Vibe: Gets confirmados e o maior Get (sem dados pessoais). */
export async function vibeStats(db: DbOrTx, vibeIds: string[]) {
  const stats = new Map<string, { confirmedGets: number; topGet: { totalCents: number; by: string; at: Date } | null }>()
  if (vibeIds.length === 0) return stats
  const counts = await db
    .select({ vibeId: gets.vibeId, n: count() })
    .from(gets)
    .where(and(inArray(gets.vibeId, vibeIds), eq(gets.status, 'CONFIRMED')))
    .groupBy(gets.vibeId)
  const tops = await db
    .selectDistinctOn([gets.vibeId], {
      vibeId: gets.vibeId,
      totalCents: gets.totalCents,
      createdAt: gets.createdAt,
      name: users.name,
    })
    .from(gets)
    .innerJoin(users, eq(users.id, gets.userId))
    .where(and(inArray(gets.vibeId, vibeIds), eq(gets.status, 'CONFIRMED')))
    .orderBy(gets.vibeId, desc(gets.totalCents), asc(gets.createdAt), asc(gets.id))
  for (const id of vibeIds) stats.set(id, { confirmedGets: 0, topGet: null })
  for (const c of counts) stats.get(c.vibeId)!.confirmedGets = c.n
  for (const t of tops) {
    stats.get(t.vibeId)!.topGet = { totalCents: t.totalCents, by: publicName(t.name), at: t.createdAt }
  }
  return stats
}

export const VIBE_SORTS = ['ending', 'newest', 'min-get', 'price-high', 'price-low'] as const
export type VibeSort = (typeof VIBE_SORTS)[number]

const SORT_ORDER: Record<VibeSort, SQL[]> = {
  ending: [asc(vibes.endsAt)],
  newest: [desc(vibes.startsAt)],
  'min-get': [asc(vibes.minGetCents), asc(vibes.endsAt)],
  'price-high': [desc(products.originalPriceCents), asc(vibes.endsAt)],
  'price-low': [asc(products.originalPriceCents), asc(vibes.endsAt)],
}

export async function listPublicVibes(
  db: DbOrTx,
  filters: { category?: Category | undefined; status?: PublicStatus | undefined; q?: string | undefined; sort?: VibeSort | undefined },
  p: Pagination,
) {
  // Filtros sem a categoria: servem para a contagem por categoria (chips da página de Vibes).
  const base: SQL[] = [inArray(vibes.status, filters.status ? [filters.status] : [...PUBLIC_STATUSES])]
  if (filters.q) base.push(ilike(products.name, `%${escapeLike(filters.q)}%`))
  const where = and(...base, ...(filters.category ? [eq(products.category, filters.category)] : []))
  const order = [...SORT_ORDER[filters.sort ?? 'ending'], asc(vibes.id)]

  const [rows, [{ total } = { total: 0 }], byCategory] = await Promise.all([
    db
      .select(vibeWithProduct)
      .from(vibes)
      .innerJoin(products, eq(products.id, vibes.productId))
      .where(where)
      .orderBy(...order)
      .limit(p.pageSize)
      .offset(offsetOf(p)),
    db.select({ total: count() }).from(vibes).innerJoin(products, eq(products.id, vibes.productId)).where(where),
    db
      .select({ category: products.category, n: count() })
      .from(vibes)
      .innerJoin(products, eq(products.id, vibes.productId))
      .where(and(...base))
      .groupBy(products.category),
  ])
  const stats = await vibeStats(
    db,
    rows.map((r) => r.id),
  )
  const facets = Object.fromEntries(byCategory.map((c) => [c.category, c.n]))
  return {
    ...paginated(
      rows.map((r) => ({ ...r, ...stats.get(r.id)! })),
      total,
      p,
    ),
    facets,
  }
}

export async function getPublicVibe(db: DbOrTx, slug: string) {
  const [row] = await db
    .select(vibeWithProduct)
    .from(vibes)
    .innerJoin(products, eq(products.id, vibes.productId))
    .where(and(eq(vibes.slug, slug), inArray(vibes.status, [...PUBLIC_STATUSES])))
    .limit(1)
  if (!row) throw notFound('Vibe não encontrada.')
  const stats = await vibeStats(db, [row.id])
  let winner: { totalCents: number; by: string } | null = null
  if (row.winnerGetId) {
    const [w] = await db
      .select({ totalCents: gets.totalCents, name: users.name })
      .from(gets)
      .innerJoin(users, eq(users.id, gets.userId))
      .where(eq(gets.id, row.winnerGetId))
    if (w) winner = { totalCents: w.totalCents, by: publicName(w.name) }
  }
  // D10: dados da página da Vibe (só no detalhe, para a lista continuar leve)
  const [[extra], [fav], recent] = await Promise.all([
    db
      .select({
        brand: products.brand,
        model: products.model,
        images: products.images,
        specs: products.specs,
        benefits: vibes.benefits,
        viewsCount: vibes.viewsCount,
      })
      .from(vibes)
      .innerJoin(products, eq(products.id, vibes.productId))
      .where(eq(vibes.id, row.id)),
    db.select({ n: count() }).from(favorites).where(eq(favorites.vibeId, row.id)),
    db
      .select({ totalCents: gets.totalCents, at: gets.createdAt, name: users.name })
      .from(gets)
      .innerJoin(users, eq(users.id, gets.userId))
      .where(and(eq(gets.vibeId, row.id), eq(gets.status, 'CONFIRMED')))
      .orderBy(desc(gets.createdAt), desc(gets.id))
      .limit(10),
  ])
  const { winnerGetId: _omit, ...rest } = row
  const images = extra!.images.length ? extra!.images : rest.product.imageUrl ? [rest.product.imageUrl] : []
  return {
    ...rest,
    product: { ...rest.product, brand: extra!.brand, model: extra!.model, images, specs: extra!.specs },
    benefits: extra!.benefits,
    viewsCount: extra!.viewsCount,
    favoritesCount: fav?.n ?? 0,
    // Últimos Gets confirmados: só valor, horário e nome público (primeiro nome + inicial)
    recentGets: recent.map((r) => ({ totalCents: r.totalCents, at: r.at, by: publicName(r.name) })),
    ...stats.get(row.id)!,
    winner,
  }
}

/** Dia corrente no fuso de Brasília (AAAA-MM-DD), para contar visitante único por dia. */
function todaySaoPaulo() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
}

/**
 * D10: registra a visita de um visitante (hash do id aleatório do cookie) uma vez por dia por Vibe
 * e devolve o total. O contador só sobe quando a linha do dia é nova.
 */
export async function registerView(db: DbOrTx, slug: string, visitorHash: string) {
  const [v] = await db
    .select({ id: vibes.id, viewsCount: vibes.viewsCount })
    .from(vibes)
    .where(and(eq(vibes.slug, slug), inArray(vibes.status, [...PUBLIC_STATUSES])))
  if (!v) throw notFound('Vibe não encontrada.')
  const inserted = await db
    .insert(vibeViews)
    .values({ vibeId: v.id, visitorHash, day: todaySaoPaulo() })
    .onConflictDoNothing()
    .returning({ vibeId: vibeViews.vibeId })
  if (inserted.length === 0) return v.viewsCount
  const [u] = await db
    .update(vibes)
    .set({ viewsCount: sql`${vibes.viewsCount} + 1` })
    .where(eq(vibes.id, v.id))
    .returning({ viewsCount: vibes.viewsCount })
  return u!.viewsCount
}

/** D10: favoritos do usuário (ids das Vibes). */
export async function listFavoriteIds(db: DbOrTx, userId: string) {
  const rows = await db.select({ vibeId: favorites.vibeId }).from(favorites).where(eq(favorites.userId, userId))
  return rows.map((r) => r.vibeId)
}

export async function setFavorite(db: DbOrTx, userId: string, vibeId: string, on: boolean) {
  if (!on) {
    await db.delete(favorites).where(and(eq(favorites.userId, userId), eq(favorites.vibeId, vibeId)))
    return
  }
  const [v] = await db
    .select({ id: vibes.id })
    .from(vibes)
    .where(and(eq(vibes.id, vibeId), inArray(vibes.status, [...PUBLIC_STATUSES])))
  if (!v) throw notFound('Vibe não encontrada.')
  await db.insert(favorites).values({ userId, vibeId }).onConflictDoNothing()
}
