/* eslint-disable no-shadow */
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { createSingletonPromise } from '@antfu/utils'
import SQLite from 'better-sqlite3'
import { Kysely, Migrator, MysqlDialect, PostgresDialect, SqliteDialect } from 'kysely'
import { createPool } from 'mysql2'
import pg from 'pg'
import { match } from 'ts-pattern'
import { env } from './env'
import { logger } from './logger'
import { getMetrics } from './metrics'
import { migrations } from './migrations'

interface CacheEntry {
  id: string
  key: string
  version: string
  updatedAt: number
  locationId: string
}

export interface StorageLocation {
  id: string
  folderName: string
  /**
   * Number of parts uploaded for this entry or null if parts have already been combined
   */
  partCount: number
  mergeStartedAt: number | null
  mergedAt: number | null
  partsDeletedAt: number | null
  lastDownloadedAt: number | null
}

interface Upload {
  id: number
  key: string
  version: string
  createdAt: number
  lastPartUploadedAt: number | null
  folderName: string
}

export interface Database {
  cache_entries: CacheEntry
  storage_locations: StorageLocation
  uploads: Upload
}

const dbLogger = logger.withTag('db')

function extractTableName(sql: string): string {
  // Match common SQL patterns to extract table name
  const patterns = [
    /\bFROM\s+["'`]?(\w+)["'`]?/i,
    /\bINTO\s+["'`]?(\w+)["'`]?/i,
    /\bUPDATE\s+["'`]?(\w+)["'`]?/i,
    /\bJOIN\s+["'`]?(\w+)["'`]?/i,
  ]

  for (const pattern of patterns) {
    const match = sql.match(pattern)
    if (match) return match[1]
  }

  return 'unknown'
}

export const getDatabase = createSingletonPromise(async () => {
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

  const metrics = await getMetrics()

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

      // Record metrics for all queries
      if (metrics && event.level === 'query') {
        const table = extractTableName(event.query.sql)
        const durationSeconds = event.queryDurationMillis / 1000

        metrics.dbQueryDuration.record(durationSeconds, { table })
        metrics.dbQueriesTotal.add(1, { table })
      }
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
