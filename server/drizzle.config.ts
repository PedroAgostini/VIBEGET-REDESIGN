import { defineConfig } from 'drizzle-kit'

// Gera SQL versionado em ./drizzle a partir do schema. Não precisa de conexão.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  strict: true,
  verbose: true,
})
