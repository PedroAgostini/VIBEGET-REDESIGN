import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import sharp, { type OutputInfo } from 'sharp'
import type { DbOrTx } from '../../db/client.js'
import { uploadedImages } from '../../db/schema.js'
import { AppError } from '../../lib/errors.js'

export type ImageKind = 'jpeg' | 'png' | 'webp'

export const EXT: Record<ImageKind, string> = { jpeg: 'jpg', png: 'png', webp: 'webp' }
export const CONTENT_TYPE: Record<string, string> = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }
/** Nome gerado pelo servidor: <uuid>.<ext>. Qualquer outra coisa em /uploads/:name é 404. */
export const UPLOAD_NAME_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$/

/** Tipo real pelos magic bytes (ignora nome do arquivo e Content-Type enviados pelo cliente). SVG nunca passa. */
export function detectImage(buf: Buffer): ImageKind | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg'
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png'
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp'
  return null
}

const MAX_PIXELS = 40_000_000 // ~ 8000 x 5000; protege contra "decompression bomb"
const MAX_SIDE = 2400 // imagens maiores são reduzidas

/**
 * Valida e REPROCESSA a imagem: decodifica com sharp (arquivo corrompido/poliglota falha aqui),
 * aplica a rotação do EXIF, reduz se for enorme e re-encoda no mesmo formato SEM metadados (EXIF/GPS/XMP).
 */
export interface ImageStore {
  storage: 'disk' | 'db'
  uploadDir: string
  db: DbOrTx
}

export async function storeImage(store: ImageStore, input: Buffer) {
  const kind = detectImage(input)
  if (!kind) {
    throw new AppError(415, 'UNSUPPORTED_IMAGE', 'Envie uma imagem JPEG, PNG ou WebP.')
  }
  let out: Buffer
  let info: OutputInfo
  try {
    const meta = await sharp(input, { limitInputPixels: MAX_PIXELS }).metadata()
    if (meta.format !== kind) throw new Error('formato divergente')
    let img = sharp(input, { limitInputPixels: MAX_PIXELS, failOn: 'error' })
      .rotate()
      .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: 'inside', withoutEnlargement: true })
    img = kind === 'jpeg' ? img.jpeg({ quality: 85 }) : kind === 'png' ? img.png({ compressionLevel: 9 }) : img.webp({ quality: 85 })
    ;({ data: out, info } = await img.toBuffer({ resolveWithObject: true }))
  } catch {
    throw new AppError(415, 'UNSUPPORTED_IMAGE', 'Imagem inválida ou corrompida.')
  }

  const name = `${randomUUID()}.${EXT[kind]}`
  if (store.storage === 'db') {
    await store.db.insert(uploadedImages).values({ name, contentType: CONTENT_TYPE[EXT[kind]]!, data: out })
  } else {
    const dir = path.resolve(store.uploadDir)
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, name), out, { flag: 'wx' })
  }
  return {
    url: `/uploads/${name}`,
    contentType: CONTENT_TYPE[EXT[kind]]!,
    bytes: out.length,
    width: info.width,
    height: info.height,
  }
}
