import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { hash, verify } from '@node-rs/argon2'

// Parâmetros Argon2id (OWASP: m=19 MiB, t=2, p=1 como mínimo)
// algorithm 2 = Algorithm.Argon2id (const enum não acessível com verbatimModuleSyntax)
const ARGON_OPTS = { algorithm: 2 as const, memoryCost: 19_456, timeCost: 2, parallelism: 1 }

export const hashPassword = (password: string) => hash(password, ARGON_OPTS)

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password)
  } catch {
    return false
  }
}

let dummyHash: Promise<string> | undefined
/** Faz uma verificação falsa para igualar o tempo de resposta quando o usuário não existe. */
export async function fakePasswordVerify(password: string): Promise<void> {
  dummyHash ??= hashPassword(randomToken())
  await verifyPassword(await dummyHash, password)
}

/** Token opaco aleatório (256 bits) em base64url. */
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url')

/** SHA-256 em hex: é o que guardamos no banco para tokens opacos. */
export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')

export function hmacSha256Hex(secret: string, payload: string | Buffer): string {
  return createHmac('sha256', secret).update(payload).digest('hex')
}

/** Comparação em tempo constante de strings (tamanhos diferentes retornam false sem vazar tempo útil). */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ba.length !== bb.length) {
    timingSafeEqual(ba, ba)
    return false
  }
  return timingSafeEqual(ba, bb)
}

const REF_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
export function referralCode(length = 8): string {
  let out = ''
  for (let i = 0; i < length; i++) out += REF_ALPHABET[randomInt(REF_ALPHABET.length)]
  return out
}
