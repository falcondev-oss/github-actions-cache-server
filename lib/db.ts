/* eslint-disable no-shadow */
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { createSingletonPromise } from '@antfu/utils'
import SQLite from 'better-sqlite3'
import { Kysely, Migrator, MysqlDialect, PostgresDialect, SqliteDialect } from 'kysely'
import { createPool } from 'mysql2'
import pg from 'pg'
import { match } from 'ts-pattern'
import z from 'zod'
import { env } from './env'
import { logger } from './logger'
import { migrations } from './migrations'

export const cacheEntrySchema = z.object({
  id: z.string(),
  key: z.string(),
  version: z.string(),
  scope: z.string(),
  updatedAt: z.number(),
  locationId: z.string(),
})
type CacheEntry = z.infer<typeof cacheEntrySchema>

export const storageLocationSchema = z.object({
  id: z.string(),
  folderName: z.string(),
  partCount: z.number(),
  mergeStartedAt: z.number().nullable(),
  mergedAt: z.number().nullable(),
  partsDeletedAt: z.number().nullable(),
  lastDownloadedAt: z.number().nullable(),
})
export type StorageLocation = z.infer<typeof storageLocationSchema>

export const uploadSchema = z.object({
  id: z.number(),
  key: z.string(),
  version: z.string(),
  scope: z.string(),
  createdAt: z.number(),
  lastPartUploadedAt: z.number().nullable(),
  startedPartUploadCount: z.number(),
  finishedPartUploadCount: z.number(),
  folderName: z.string(),
})
type Upload = z.infer<typeof uploadSchema>

export interface Database {
  cache_entries: CacheEntry
  storage_locations: StorageLocation
  uploads: Upload
}

const dbLogger = logger.withTag('db')

export const getDatabase = createSingletonPromise(async () => {
  if(process.env.NODE_CAGED === 'true' && env.DB_DRIVER === 'sqlite') throw new Error('SQLite is not supported with `caged` image variant.')

  const dialect = await match(env)
    .with({ DB_DRIVER: 'postgres' }, async (env) => {
      const pool = new pg.Pool(
        env.DB_POSTGRES_URL
          ? {
              connectionString: env.DB_POSTGRES_URL,
              max: 10,
            }
          : {
              database: env.DB_POSTGRES_DATABASE,
              host: env.DB_POSTGRES_HOST,
              password: env.DB_POSTGRES_PASSWORD,
              port: env.DB_POSTGRES_PORT,
              user: env.DB_POSTGRES_USER,
              max: 10,
            },
      )
      await pool.connect()

      return new PostgresDialect({
        pool,
      })
    })
    .with(
      {
        DB_DRIVER: 'mysql',
      },
      async (env) => {
        const pool = createPool({
          database: env.DB_MYSQL_DATABASE,
          host: env.DB_MYSQL_HOST,
          password: env.DB_MYSQL_PASSWORD,
          port: env.DB_MYSQL_PORT,
          user: env.DB_MYSQL_USER,
          connectionLimit: 10,
        })

        return new MysqlDialect({
          pool,
        })
      },
    )
    .with(
      {
        DB_DRIVER: 'sqlite',
      },
      async (env) => {
        await mkdir(path.dirname(env.DB_SQLITE_PATH), { recursive: true })
        return new SqliteDialect({
          database: new SQLite(env.DB_SQLITE_PATH),
        })
      },
    )
    .exhaustive()

  const db = new Kysely<Database>({
    dialect,
    log: (event) => {
      if (event.level === 'error')
        dbLogger.error('Query failed', {
          durationMs: event.queryDurationMillis,
          error: event.error,
          sql: event.query.sql,
          params: event.query.parameters,
        })
      else if (event.level === 'query' && env.DEBUG)
        dbLogger.debug('Executed query', {
          durationMs: event.queryDurationMillis,
          sql: event.query.sql,
          params: event.query.parameters,
        })
    },
  })

  logger.info('Migrating database...')
  const migrator = new Migrator({
    db,
    provider: {
      async getMigrations() {
        return migrations(env.DB_DRIVER)
      },
    },
  })
  const { error, results } = await migrator.migrateToLatest()
  if (error) {
    logger.error('Database migration failed', error)
    // eslint-disable-next-line unicorn/no-process-exit
    process.exit(1)
  }
  logger.debug('Migration results', results)
  logger.success('Database migrated')

  return db
})
