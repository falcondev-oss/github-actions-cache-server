import { Kysely, Migrator } from 'kysely'

import type { DatabaseDriverName } from '~/db-drivers'
import { getDatabaseDriver } from '~/db-drivers'
import { migrations } from '~/lib/db/migrations'
import { ENV } from '~/lib/env'
import { logger } from '~/lib/logger'

import type { Selectable } from 'kysely'

export interface Database {
  cache_keys: CacheKeysTable
}

export interface CacheKeysTable {
  key: string
  version: string
  updated_at: string
  accessed_at: string
}

async function initializeDatabase() {
  const driverName = ENV.DB_DRIVER
  const driverSetup = getDatabaseDriver(driverName)
  if (!driverSetup) {
    logger.error(`No database driver found for ${driverName}`)
    // eslint-disable-next-line unicorn/no-process-exit
    process.exit(1)
  }
  logger.info(`Using database driver: ${driverName}`)

  const driver = await driverSetup()

  const db = new Kysely<Database>({
    dialect: driver,
  })

  logger.info('Migrating database...')
  const migrator = new Migrator({
    db,
    provider: {
      async getMigrations() {
        return migrations(driverName as DatabaseDriverName)
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
}

const db = await initializeDatabase()

/**
 * @see https://docs.github.com/en/actions/using-workflows/caching-dependencies-to-speed-up-workflows#matching-a-cache-key
 */
export async function findKeyMatch(opts: { key: string; version: string; restoreKeys?: string[] }) {
  logger.debug('Finding key match', opts)
  const exactPrimaryMatch = await db
    .selectFrom('cache_keys')
    .where('key', '=', opts.key)
    .where('version', '=', opts.version)
    .selectAll()
    .executeTakeFirst()
  if (exactPrimaryMatch) {
    return exactPrimaryMatch
  }

  logger.debug('No exact primary matches found')

  if (!opts.restoreKeys) {
    logger.debug('No restore keys provided')
    return
  }

  logger.debug('Trying restore keys', opts.restoreKeys)
  for (const key of opts.restoreKeys) {
    const exactMatch = await db
      .selectFrom('cache_keys')
      .where('version', '=', opts.version)
      .where('key', '=', key)
      .orderBy('cache_keys.updated_at desc')
      .selectAll()
      .executeTakeFirst()
    if (exactMatch) {
      return exactMatch
    }

    logger.debug('No exact matches found for', key)

    const prefixedMatch = await db
      .selectFrom('cache_keys')
      .where('version', '=', opts.version)
      .where('key', 'like', `${key}%`)
      .orderBy('cache_keys.updated_at desc')
      .selectAll()
      .executeTakeFirst()

    if (prefixedMatch) {
      return prefixedMatch
    }

    logger.debug('No prefixed matches found for', key)
  }
}

export async function updateOrCreateKey(key: string, version: string, date?: Date) {
  const now = date ?? new Date()
  const updateResult = await db
    .updateTable('cache_keys')
    .set('updated_at', now.toISOString())
    .set('accessed_at', now.toISOString())
    .where('key', '=', key)
    .where('version', '=', version)
    .executeTakeFirst()
  if (Number(updateResult.numUpdatedRows) === 0) {
    await createKey(key, version, date)
  }
}

export async function touchKey(key: string, version: string, date?: Date) {
  const now = date ?? new Date()
  await db
    .updateTable('cache_keys')
    .set('accessed_at', now.toISOString())
    .where('key', '=', key)
    .where('version', '=', version)
    .execute()
}

export async function findStaleKeys(olderThanDays: number | undefined, date?: Date) {
  if (olderThanDays === undefined) return db.selectFrom('cache_keys').selectAll().execute()

  const now = date ?? new Date()
  const threshold = new Date(now.getTime() - olderThanDays * 24 * 60 * 60 * 1000)
  return db
    .selectFrom('cache_keys')
    .where('accessed_at', '<', threshold.toISOString())
    .selectAll()
    .execute()
}

export async function createKey(key: string, version: string, date?: Date) {
  const now = date ?? new Date()
  await db
    .insertInto('cache_keys')
    .values({
      key,
      version,
      updated_at: now.toISOString(),
      accessed_at: now.toISOString(),
    })
    .execute()
}

export async function pruneKeys(keys?: Selectable<CacheKeysTable>[]) {
  if (keys) {
    await db.transaction().execute(async (tx) => {
      for (const { key, version } of keys) {
        await tx
          .deleteFrom('cache_keys')
          .where('key', '=', key)
          .where('version', '=', version)
          .execute()
      }
    })
  } else {
    await db.deleteFrom('cache_keys').execute()
  }
}
