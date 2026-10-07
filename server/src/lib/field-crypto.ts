import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto'

/**
 * Criptografia de campos pessoais (LGPD): AES-256-GCM por valor, chave fora do banco.
 *
 * Formato gravado: `enc:<idDaChave>:<base64url(iv 12 | tag 16 | cifra)>`.
 * - IV aleatório por valor: o mesmo CPF gravado duas vezes gera cifras diferentes.
 * - GCM autentica: cifra alterada no banco falha ao decifrar (não devolve lixo).
 * - O id da chave permite rotação: chaves antigas continuam decifrando (DATA_KEYS_OLD).
 *
 * Busca por igualdade (login por e-mail, CPF único) usa o índice cego `blindIndex`:
 * HMAC-SHA256 com outra chave, que não revela o valor e não muda na rotação.
 */

const PREFIX = 'enc:'
const IV_BYTES = 12
const TAG_BYTES = 16

type Keyring = { currentId: string; keys: Map<string, Buffer>; indexKey: Buffer }
let ring: Keyring | null = null

/** Deriva a chave AES-256 de um segredo qualquer (≥ 32 caracteres) com HKDF-SHA256. */
const derive = (secret: string, info: string) => Buffer.from(hkdfSync('sha256', secret, 'vibeget-field-crypto', info, 32))

export interface FieldCryptoConfig {
  /** Segredo da chave atual de criptografia. */
  key: string
  /** Identificador da chave atual (vai junto com cada valor cifrado). */
  keyId: string
  /** Chaves antigas, só para decifrar: id → segredo. */
  previous?: Record<string, string>
  /** Segredo do índice cego (estável: não troca na rotação da chave de criptografia). */
  indexKey: string
}

/** Liga a criptografia (na subida da API e dos scripts). Sem isso, gravar/ler campo cifrado falha. */
export function configureFieldCrypto(cfg: FieldCryptoConfig) {
  if (!/^[a-z0-9]{1,16}$/i.test(cfg.keyId)) throw new Error('DATA_KEY_ID inválido (use letras e números, até 16).')
  const keys = new Map<string, Buffer>()
  for (const [id, secret] of Object.entries(cfg.previous ?? {})) keys.set(id, derive(secret, `enc:${id}`))
  keys.set(cfg.keyId, derive(cfg.key, `enc:${cfg.keyId}`))
  ring = { currentId: cfg.keyId, keys, indexKey: derive(cfg.indexKey, 'blind-index') }
}

function keyring(): Keyring {
  if (!ring) throw new Error('Criptografia de campos não configurada (configureFieldCrypto).')
  return ring
}

export const isEncrypted = (value: string) => value.startsWith(PREFIX)

export function encryptField(plain: string): string {
  const { currentId, keys } = keyring()
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', keys.get(currentId)!, iv)
  // O id da chave entra como dado autenticado: trocar o prefixo no banco invalida o valor.
  cipher.setAAD(Buffer.from(currentId))
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return `${PREFIX}${currentId}:${Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url')}`
}

/** Decifra. Valor sem o prefixo é dado antigo ainda não migrado e volta como está. */
export function decryptField(value: string): string {
  if (!isEncrypted(value)) return value
  const { keys } = keyring()
  const sep = value.indexOf(':', PREFIX.length)
  const id = value.slice(PREFIX.length, sep)
  const key = keys.get(id)
  if (sep < 0 || !key) throw new Error(`Chave de dados "${id}" indisponível para decifrar.`)
  const raw = Buffer.from(value.slice(sep + 1), 'base64url')
  const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, IV_BYTES))
  decipher.setAAD(Buffer.from(id))
  decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES))
  return Buffer.concat([decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString('utf8')
}

/** Valor em texto puro ou cifrado com uma chave que não é a atual (precisa ser recifrado). */
export function needsReencrypt(value: string): boolean {
  return !isEncrypted(value) || !value.startsWith(`${PREFIX}${keyring().currentId}:`)
}

/** Índice cego para busca por igualdade (o valor já deve vir normalizado: e-mail minúsculo, CPF só dígitos). */
export function blindIndex(value: string): string {
  return createHmac('sha256', keyring().indexKey).update(value, 'utf8').digest('hex')
}

export const emailIndex = (email: string) => blindIndex(email.trim().toLowerCase())
export const cpfIndex = (cpf: string) => blindIndex(cpf.replace(/\D/g, ''))

export const currentKeyId = () => keyring().currentId

/** Liga a criptografia a partir das variáveis de ambiente já validadas (config/env.ts). */
export function configureFieldCryptoFromEnv(env: { DATA_KEY: string; DATA_KEY_ID: string; DATA_KEYS_OLD: Record<string, string>; DATA_INDEX_KEY: string }) {
  configureFieldCrypto({ key: env.DATA_KEY, keyId: env.DATA_KEY_ID, previous: env.DATA_KEYS_OLD, indexKey: env.DATA_INDEX_KEY })
}
