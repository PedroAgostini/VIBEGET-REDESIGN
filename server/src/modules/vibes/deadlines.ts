import type { Settings } from '../../lib/settings.js'

/**
 * D1 — prazos derivados do fim da Vibe:
 * - cutoffAt: a partir daqui nenhum Get novo (ends_at - get_cutoff_seconds);
 * - paymentDeadline: último instante em que um PAID ainda conta (cutoffAt + payment_grace_seconds, <= ends_at).
 * O prazo efetivo de cada pagamento fica gravado em payments.expires_at no momento da criação do Get,
 * então mudar as configurações depois não altera Gets já criados.
 */
export function vibeDeadlines(endsAt: Date, cfg: Pick<Settings, 'getCutoffSeconds' | 'paymentGraceSeconds'>) {
  const cutoffAt = new Date(endsAt.getTime() - cfg.getCutoffSeconds * 1000)
  const paymentDeadline = new Date(
    Math.min(cutoffAt.getTime() + cfg.paymentGraceSeconds * 1000, endsAt.getTime()),
  )
  return { cutoffAt, paymentDeadline }
}
