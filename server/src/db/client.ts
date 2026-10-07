import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import type { ExtractTablesWithRelations } from 'drizzle-orm'
import type { PgDatabase, PgQueryResultHKT, PgTransaction } from 'drizzle-orm/pg-core'
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite'
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator'
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres'
import { migrate as migratePg } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import * as schema from './schema.js'

export type Schema = typeof schema
export type Db = PgDatabase<PgQueryResultHKT, Schema, ExtractTablesWithRelations<Schema>>
export type Tx = PgTransaction<PgQueryResultHKT, Schema, ExtractTablesWithRelations<Schema>>
/** Aceita tanto a conexão quanto uma transação aberta. */
export type DbOrTx = Db | Tx

export interface DbHandle {
  db: Db
  kind: 'pglite' | 'postgres'
  migrate: () => Promise<void>
  close: () => Promise<void>
}

const here = path.dirname(fileURLToPath(import.meta.url))
// src/db -> ../../drizzle ; dist/src/db -> ../../../drizzle
export const MIGRATIONS_FOLDER = [path.resolve(here, '../../drizzle'), path.resolve(here, '../../../drizzle')].find(
  (p) => existsSync(path.join(p, 'meta')),
) ?? path.resolve(here, '../../drizzle')

export interface CreateDbOptions {
  databaseUrl?: string | undefined
  /** Diretório do PGlite. `null` = memória (testes). */
  pgliteDataDir?: string | null
  /** Conexões no pool do Postgres (serverless usa poucas por instância). */
  maxConnections?: number
}

export async function createDb(opts: CreateDbOptions): Promise<DbHandle> {
  if (opts.databaseUrl) {
    const pool = new pg.Pool({ connectionString: opts.databaseUrl, max: opts.maxConnections ?? 10 })
    const db = drizzlePg({ client: pool, schema })
    return {
      db: db as unknown as Db,
      kind: 'postgres',
      migrate: () => migratePg(db, { migrationsFolder: MIGRATIONS_FOLDER }),
      close: () => pool.end(),
    }
  }

  let client: PGlite
  if (opts.pgliteDataDir) {
    const dir = path.resolve(opts.pgliteDataDir)
    mkdirSync(dir, { recursive: true })
    client = new PGlite(dir)
  } else {
    client = new PGlite()
  }
  await client.waitReady
  const db = drizzlePglite({ client, schema })
  return {
    db: db as unknown as Db,
    kind: 'pglite',
    migrate: () => migratePglite(db, { migrationsFolder: MIGRATIONS_FOLDER }),
    close: () => client.close(),
  }
}
