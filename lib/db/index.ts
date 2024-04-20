import { Kysely, Migrator } from 'kysely'

import { getDatabaseDriver } from '@/db-drivers'
import { migrations } from '@/lib/db/migrations'
import { ENV } from '@/lib/env'
import { logger } from '@/lib/logger'

export interface Database {
  cache_keys: CacheKeysTable
}

export interface CacheKeysTable {
  key: string
  version: string
  updated_at: string
}

async function initializeDatabase() {
  const driverName = ENV.DB_DRIVER
  const driverSetup = getDatabaseDriver(driverName)
  if (!driverSetup) {
    logger.error(`No database driver found for ${driverName}`)
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
        return migrations(driverName as 'sqlite' | 'postgres' | 'mysql')
      },
    },
  })
  const { error, results } = await migrator.migrateToLatest()
  if (error) {
    logger.error('Database migration failed', error)
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
    .where('key', '==', opts.key)
    .where('version', '==', opts.version)
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
      .where('version', '==', opts.version)
      .where('key', '==', key)
      .orderBy('cache_keys.updated_at desc')
      .selectAll()
      .executeTakeFirst()
    if (exactMatch) {
      return exactMatch
    }

    logger.debug('No exact matches found for', key)

    const prefixedMatch = await db
      .selectFrom('cache_keys')
      .where('version', '==', opts.version)
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

export async function touchKey(key: string, version: string) {
  const now = new Date()
  const updatedKey = await db
    .updateTable('cache_keys')
    .set('updated_at', now.toISOString())
    .where('key', '==', key)
    .where('version', '==', version)
    .returningAll()
    .executeTakeFirst()
  if (!updatedKey) {
    await createKey(key, version)
  }
}

export async function createKey(key: string, version: string) {
  const now = new Date()
  await db
    .insertInto('cache_keys')
    .values({
      key,
      version,
      updated_at: now.toISOString(),
    })
    .execute()
}

export async function pruneKeys() {
  await db.deleteFrom('cache_keys').execute()
}
