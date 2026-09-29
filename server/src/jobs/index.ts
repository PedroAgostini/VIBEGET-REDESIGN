import type { AppContext } from '../context.js'
import { safeErrorForLog } from '../lib/log-safety.js'
import { expireStalePayments } from '../modules/payments/service.js'
import { activateScheduledVibes, settleDueVibes } from '../modules/vibes/settlement.js'

/** Rotina periódica: agenda -> LIVE, expira pagamentos pendentes, encerra Vibes vencidas. */
export async function runScheduledJobs(ctx: Pick<AppContext, 'db' | 'log'>, now = new Date()) {
  const activated = await activateScheduledVibes(ctx, now)
  const expiredPayments = await expireStalePayments(ctx, now)
  const settled = await settleDueVibes(ctx, now)
  return { activated, expiredPayments, settled: settled.length }
}

/** Inicia o intervalo (0 desativa). Retorna função para parar. */
export function startJobs(ctx: Pick<AppContext, 'db' | 'log'>, intervalMs: number) {
  if (intervalMs <= 0) return () => {}
  let running = false
  const timer = setInterval(async () => {
    if (running) return
    running = true
    try {
      const r = await runScheduledJobs(ctx)
      if (r.activated || r.expiredPayments || r.settled) ctx.log.info(r, 'jobs executados')
    } catch (err) {
      ctx.log.error({ error: safeErrorForLog(err) }, 'falha nos jobs agendados')
    } finally {
      running = false
    }
  }, intervalMs)
  timer.unref()
  return () => clearInterval(timer)
}
