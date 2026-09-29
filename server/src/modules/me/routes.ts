import type { FastifyInstance } from 'fastify'
import { paginationSchema } from '../../lib/pagination.js'
import { parse } from '../../lib/validate.js'
import { authOf, metaOf } from '../../plugins/auth.js'
import { REFRESH_COOKIE, REFRESH_COOKIE_PATH } from '../auth/routes.js'
import { z } from 'zod'
import { getMyGet, getsSummary, leadingVibes, listMyGets } from '../gets/service.js'
import { listFavoriteIds, setFavorite } from '../vibes/service.js'

const uuidParams = z.object({ id: z.uuid() }).strict()
import { vibeDeadlines } from '../vibes/deadlines.js'
import { getBalance, listLedger } from '../wallet/service.js'
import { deleteMeSchema, updateMeSchema } from './schemas.js'
import * as me from './service.js'

export default async function meRoutes(app: FastifyInstance) {
  const { ctx } = app
  // Todas as rotas deste módulo exigem login; os dados são sempre do próprio usuário (sem IDOR).
  app.addHook('preHandler', app.authenticate)

  app.get('/me/dashboard', async (req) => ({ data: await me.dashboard(ctx, authOf(req).userId) }))

  app.patch('/me', async (req) => {
    const input = parse(updateMeSchema, req.body)
    return { user: await me.updateMe(ctx, authOf(req).userId, input, metaOf(req)) }
  })

  // D9: números e lista "vencendo agora" (rotas estáticas antes de qualquer /me/gets/:param)
  app.get('/me/gets/summary', async (req) => ({ data: await getsSummary(ctx.db, authOf(req).userId) }))
  app.get('/me/gets/leading', async (req) => {
    const cfg = await ctx.settings.get()
    const rows = await leadingVibes(ctx.db, authOf(req).userId)
    return {
      data: rows.map((r) => ({ ...r, vibe: { ...r.vibe, getsCloseAt: vibeDeadlines(r.vibe.endsAt, cfg).cutoffAt } })),
    }
  })

  app.get('/me/gets/:id', async (req) => {
    const { id } = parse(uuidParams, req.params)
    return { data: await getMyGet(ctx.db, authOf(req).userId, id) }
  })

  // D10: favoritos
  app.get('/me/favorites', async (req) => ({ data: await listFavoriteIds(ctx.db, authOf(req).userId) }))
  app.put('/me/favorites/:id', async (req, reply) => {
    const { id } = parse(uuidParams, req.params)
    await setFavorite(ctx.db, authOf(req).userId, id, true)
    return reply.status(204).send()
  })
  app.delete('/me/favorites/:id', async (req, reply) => {
    const { id } = parse(uuidParams, req.params)
    await setFavorite(ctx.db, authOf(req).userId, id, false)
    return reply.status(204).send()
  })

  app.get('/me/gets', async (req) => {
    const p = parse(paginationSchema.strict(), req.query)
    return listMyGets(ctx.db, authOf(req).userId, p)
  })

  app.get('/me/wallet', async (req) => {
    const p = parse(paginationSchema.strict(), req.query)
    const userId = authOf(req).userId
    const [balanceCents, ledger] = await Promise.all([getBalance(ctx.db, userId), listLedger(ctx.db, userId, p)])
    return { balanceCents, ...ledger }
  })

  app.get('/me/export', { config: { rateLimit: { max: 5, timeWindow: '1 hour' } } }, async (req, reply) => {
    const data = await me.exportMyData(ctx, authOf(req).userId)
    reply.header('cache-control', 'no-store')
    reply.header('content-disposition', 'attachment; filename="vibeget-meus-dados.json"')
    return data
  })

  app.delete('/me', { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } }, async (req, reply) => {
    const { password } = parse(deleteMeSchema, req.body)
    await me.deleteMe(ctx, authOf(req).userId, password, metaOf(req))
    reply.clearCookie(REFRESH_COOKIE, { path: REFRESH_COOKIE_PATH })
    return reply.status(204).send()
  })
}
