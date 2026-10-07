import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { products } from '../../db/schema.js'
import { paginationSchema } from '../../lib/pagination.js'
import { parse } from '../../lib/validate.js'
import { vibeDeadlines } from './deadlines.js'
import { getPublicVibe, listPublicVibes, PUBLIC_STATUSES, registerView, VIBE_SORTS } from './service.js'
import { randomToken, sha256 } from '../../lib/crypto.js'
import { csrfGuard } from '../../plugins/security.js'

const VISITOR_COOKIE = 'vg_vid'

const listQuery = paginationSchema
  .extend({
    category: z.enum(products.category.enumValues).optional(),
    status: z.enum(PUBLIC_STATUSES).optional(),
    // Busca pelo nome do produto (escapada para LIKE no service).
    q: z.string().trim().min(1).max(80).optional(),
    sort: z.enum(VIBE_SORTS).optional(),
  })
  .strict()

const slugParams = z.object({ slug: z.string().regex(/^[a-z0-9-]{1,140}$/) }).strict()

export default async function vibeRoutes(app: FastifyInstance) {
  const { db } = app.ctx

  // D1: getsCloseAt = momento em que a Vibe para de aceitar Gets (ends_at - get_cutoff_seconds).
  const withCutoff = async <T extends { endsAt: Date }>(v: T) => ({
    ...v,
    getsCloseAt: vibeDeadlines(v.endsAt, await app.ctx.settings.get()).cutoffAt,
  })

  app.get('/vibes', async (req) => {
    const q = parse(listQuery, req.query)
    const page = await listPublicVibes(db, { category: q.category, status: q.status, q: q.q, sort: q.sort }, q)
    return { ...page, data: await Promise.all(page.data.map(withCutoff)) }
  })

  app.get('/vibes/:slug', async (req) => {
    const { slug } = parse(slugParams, req.params)
    return { data: await withCutoff(await getPublicVibe(db, slug)) }
  })

  // D10: visitante único por dia. O navegador guarda só um id aleatório (cookie httpOnly);
  // o banco guarda o SHA-256 dele, sem IP nem dado pessoal.
  app.post(
    '/vibes/:slug/view',
    { preHandler: csrfGuard(app), config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const { slug } = parse(slugParams, req.params)
      let vid = req.cookies[VISITOR_COOKIE]
      if (!vid || !/^[A-Za-z0-9_-]{16,64}$/.test(vid)) {
        vid = randomToken(18)
        reply.setCookie(VISITOR_COOKIE, vid, {
          httpOnly: true,
          secure: app.ctx.env.COOKIE_SECURE,
          sameSite: 'lax',
          path: '/api/v1/vibes',
          maxAge: 365 * 24 * 60 * 60,
        })
      }
      return { data: { viewsCount: await registerView(db, slug, sha256(vid)) } }
    },
  )
}
