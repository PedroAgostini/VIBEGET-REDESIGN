import type { User } from '../db/schema.js'

export function maskCpf(cpf: string | null): string | null {
  if (!cpf) return null
  return `***.${cpf.slice(3, 6)}.${cpf.slice(6, 9)}-**`
}

/** Nome público: primeiro nome + inicial do último sobrenome ("Pedro A."). */
export function publicName(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return 'Anônimo'
  const first = parts[0]!
  if (parts.length === 1) return first
  return `${first} ${parts[parts.length - 1]![0]!.toUpperCase()}.`
}

/** D8: endereço do usuário, ou null se o CEP ainda não foi informado. */
export function addressOf(u: User) {
  if (!u.cep) return null
  return {
    cep: u.cep,
    street: u.street,
    number: u.number,
    complement: u.complement,
    district: u.district,
    city: u.city,
    state: u.state,
  }
}

/** D6: chave Pix mascarada (dado pessoal). Nunca devolver a chave completa ao front do usuário nem logar. */
export function maskPixKey(type: string, key: string): string {
  switch (type) {
    case 'CPF':
      return `***.${key.slice(3, 6)}.***-${key.slice(9, 11)}`
    case 'EMAIL': {
      const [user = '', domain = ''] = key.split('@')
      return `${user.slice(0, 1)}***@${domain}`
    }
    case 'PHONE':
      return `${key.slice(0, 5)}*****${key.slice(-2)}`
    default:
      return `${key.slice(0, 4)}****${key.slice(-4)}`
  }
}

/** Dados do próprio usuário (nunca inclui hash de senha, CPF completo ou contadores de segurança). */
export function toMe(u: User) {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    cpfMasked: maskCpf(u.cpf),
    hasCpf: u.cpf !== null,
    phone: u.phone,
    birthDate: u.birthDate,
    role: u.role,
    level: u.level,
    status: u.status,
    emailVerified: u.emailVerifiedAt !== null,
    referralCode: u.referralCode,
    marketingOptIn: u.marketingOptIn,
    address: addressOf(u),
    termsVersion: u.termsVersion,
    createdAt: u.createdAt,
  }
}

/** Visão administrativa (SUPPORT/ADMIN). */
export function toAdminUser(u: User) {
  return {
    ...toMe(u),
    emailVerifiedAt: u.emailVerifiedAt,
    failedLoginCount: u.failedLoginCount,
    lockedUntil: u.lockedUntil,
    referredById: u.referredById,
    termsAcceptedAt: u.termsAcceptedAt,
    updatedAt: u.updatedAt,
  }
}
