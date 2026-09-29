import type { FastifyBaseLogger } from 'fastify'

export type MailKind = 'EMAIL_VERIFY' | 'PASSWORD_RESET'

export interface SentMail {
  to: string
  kind: MailKind
  subject: string
  link: string
  /** Token em claro. Só fica disponível no MemoryMailer (testes). */
  token: string
}

export interface Mailer {
  send(mail: SentMail): Promise<void>
}

/** Testes: guarda as mensagens em memória para o teste ler o token. */
export class MemoryMailer implements Mailer {
  readonly sent: SentMail[] = []
  async send(mail: SentMail) {
    this.sent.push(mail)
  }
  last(kind?: MailKind, to?: string): SentMail | undefined {
    return [...this.sent].reverse().find((m) => (!kind || m.kind === kind) && (!to || m.to === to))
  }
}

/**
 * Dev: escreve o link no log. Em produção NÃO registra o link (contém token);
 * troque por um provedor real antes de ir ao ar.
 */
export class ConsoleMailer implements Mailer {
  constructor(
    private readonly log: FastifyBaseLogger,
    private readonly isProduction: boolean,
  ) {}
  async send(mail: SentMail) {
    if (this.isProduction) {
      this.log.warn({ kind: mail.kind }, 'ConsoleMailer em produção: e-mail não enviado (configure um provedor real)')
      return
    }
    // eslint-disable-next-line no-console
    console.info(`\n[mailer:dev] ${mail.subject} -> ${mail.to}\n  ${mail.link}\n`)
  }
}
