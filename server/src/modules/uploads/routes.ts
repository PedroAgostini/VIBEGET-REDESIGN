import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import multipart from '@fastify/multipart'
import { eq } from 'drizzle-orm'
import { uploadedImages } from '../../db/schema.js'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { audit } from '../../lib/audit.js'
import { AppError, notFound } from '../../lib/errors.js'
import { authOf, metaOf } from '../../plugins/auth.js'
import { CONTENT_TYPE, storeImage, UPLOAD_NAME_RE } from './service.js'

/** POST /api/v1/admin/uploads (só ADMIN). Registrado dentro do prefixo /api/v1. */
export async function adminUploadRoutes(app: FastifyInstance) {
  const { env } = app.ctx
  await app.register(multipart, {
    limits: { fileSize: env.UPLOAD_MAX_BYTES, files: 1, fields: 0, parts: 1, headerPairs: 50 },
  })

  app.post(
    '/admin/uploads',
    {
      preHandler: [app.authenticate, app.requireRole('ADMIN')],
      bodyLimit: env.UPLOAD_MAX_BYTES + 64 * 1024,
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      if (!req.isMultipart()) throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Envie a imagem como multipart/form-data.')
      let buf: Buffer
      try {
        const file = await req.file()
        if (!file) throw new AppError(400, 'VALIDATION_ERROR', 'Nenhum arquivo enviado.')
        buf = await file.toBuffer()
      } catch (err) {
        if (err instanceof AppError) throw err
        const code = (err as { code?: string }).code
        if (code === 'FST_REQ_FILE_TOO_LARGE') {
          throw new AppError(413, 'PAYLOAD_TOO_LARGE', `Imagem maior que o limite de ${Math.floor(env.UPLOAD_MAX_BYTES / 1_000_000)} MB.`)
        }
        throw new AppError(400, 'VALIDATION_ERROR', 'Upload inválido.')
      }
      const stored = await storeImage({ storage: env.UPLOAD_STORAGE, uploadDir: env.UPLOAD_DIR, db: app.ctx.db }, buf)
      await audit(app.ctx.db, {
        actorId: authOf(req).userId,
        action: 'IMAGE_UPLOADED',
        entity: 'upload',
        metadata: { url: stored.url, bytes: stored.bytes, contentType: stored.contentType },
        ip: metaOf(req).ip,
      })
      return reply.status(201).send({ data: stored })
    },
  )
}

const fileParams = z.object({ name: z.string().regex(UPLOAD_NAME_RE) }).strict()

/** GET /uploads/:name (público, fora de /api/v1): só arquivos gerados pelo servidor, com headers seguros. */
export async function publicUploadRoutes(app: FastifyInstance) {
  const { env, db } = app.ctx
  const dir = path.resolve(env.UPLOAD_DIR)
  app.get('/uploads/:name', async (req, reply) => {
    const r = fileParams.safeParse(req.params)
    if (!r.success) throw notFound('Arquivo não encontrado.')
    const { name } = r.data
    const ext = name.slice(name.lastIndexOf('.') + 1)
    reply
      .header('content-type', CONTENT_TYPE[ext]!)
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'; sandbox")
      .header('content-disposition', 'inline')
      .header('cross-origin-resource-policy', 'cross-origin')
      .header('cache-control', 'public, max-age=31536000, immutable')
    if (env.UPLOAD_STORAGE === 'db') {
      const [img] = await db.select({ data: uploadedImages.data }).from(uploadedImages).where(eq(uploadedImages.name, name))
      if (!img) throw notFound('Arquivo não encontrado.')
      return reply.header('content-length', String(img.data.length)).send(img.data)
    }
    const file = path.join(dir, name)
    const st = await stat(file).catch(() => null)
    if (!st || !st.isFile()) throw notFound('Arquivo não encontrado.')
    return reply.header('content-length', String(st.size)).send(createReadStream(file))
  })
}
