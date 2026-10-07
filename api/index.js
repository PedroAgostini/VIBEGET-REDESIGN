// Função serverless da API na Vercel. O código vem do build de server/ (ver "buildCommand" em vercel.json).
// As rotas /api/v1/* e /uploads/* chegam aqui pelos rewrites; o Fastify vê a URL original.
export { default } from '../server/dist/src/vercel.js'
