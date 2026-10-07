import type { FastifyInstance } from 'fastify'
import { runScheduledJobs } from '../../jobs/index.js'
import { safeEqual } from '../../lib/crypto.js'
import { unauthorized } from '../../lib/errors.js'
import { applyRetention } from '../../lib/retention.js'

/**
 * GET /api/v1/internal/jobs — chamado pelo Vercel Cron (Authorization: Bearer CRON_SECRET).
 * Em servidor comum os jobs rodam no intervalo do processo (jobs/index.ts) e esta rota nem é registrada.
 */
export default async function internalRoutes(app: FastifyInstance) {
  const secret = app.ctx.env.CRON_SECRET
  if (!secret) return
  app.get('/internal/jobs', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const header = req.headers.authorization ?? ''
    if (!safeEqual(header, `Bearer ${secret}`)) throw unauthorized()
    const { env } = app.ctx
    const jobs = await runScheduledJobs(app.ctx)
    const retention = await applyRetention(app.ctx.db, { ipDays: env.AUDIT_IP_RETENTION_DAYS, sessionDays: env.SESSION_RETENTION_DAYS })
    return { data: { jobs, retention } }
  })
}
