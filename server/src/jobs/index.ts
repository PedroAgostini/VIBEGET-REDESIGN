import type { AppContext } from '../context.js'
import { safeErrorForLog } from '../lib/log-safety.js'
import { applyRetention } from '../lib/retention.js'
import { expireStalePayments } from '../modules/payments/service.js'
import { activateScheduledVibes, settleDueVibes } from '../modules/vibes/settlement.js'

/** Rotina periódica: agenda -> LIVE, expira pagamentos pendentes, encerra Vibes vencidas. */
export async function runScheduledJobs(ctx: Pick<AppContext, 'db' | 'log'>, now = new Date()) {
  const activated = await activateScheduledVibes(ctx, now)
  const expiredPayments = await expireStalePayments(ctx, now)
  const settled = await settleDueVibes(ctx, now)
  return { activated, expiredPayments, settled: settled.length }
}

const RETENTION_EVERY_MS = 60 * 60 * 1000

/** Inicia o intervalo (0 desativa). Retorna função para parar. */
export function startJobs(ctx: Pick<AppContext, 'db' | 'log' | 'env'>, intervalMs: number) {
  if (intervalMs <= 0) return () => {}
  let running = false
  let lastRetention = 0
  const timer = setInterval(async () => {
    if (running) return
    running = true
    try {
      const r = await runScheduledJobs(ctx)
      if (r.activated || r.expiredPayments || r.settled) ctx.log.info(r, 'jobs executados')
      // LGPD: limpeza de dados pessoais vencidos, no máximo uma vez por hora.
      if (Date.now() - lastRetention >= RETENTION_EVERY_MS) {
        lastRetention = Date.now()
        const k = await applyRetention(ctx.db, { ipDays: ctx.env.AUDIT_IP_RETENTION_DAYS, sessionDays: ctx.env.SESSION_RETENTION_DAYS })
        if (k.auditIpsCleared || k.sessionsDeleted || k.tokensDeleted) ctx.log.info(k, 'retenção LGPD aplicada')
      }
    } catch (err) {
      ctx.log.error({ error: safeErrorForLog(err) }, 'falha nos jobs agendados')
    } finally {
      running = false
    }
  }, intervalMs)
  timer.unref()
  return () => clearInterval(timer)
}
