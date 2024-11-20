import { hash } from 'node:crypto'

import { Kysely, Migrator } from 'kysely'

import type { DatabaseDriverName } from '~/lib/db/drivers'
import { getDatabaseDriver } from '~/lib/db/drivers'
import { migrations } from '~/lib/db/migrations'
import { ENV } from '~/lib/env'
import { logger } from '~/lib/logger'

import type { Selectable } from 'kysely'

export interface CacheKeysTable {
  id: string
  key: string
  version: string
  updated_at: string
  accessed_at: string
}
export interface UploadsTable {
  created_at: string
  key: string
  version: string
  id: string
  driver_upload_id: string
}
export interface UploadPartsTable {
  upload_id: string
  part_number: number
  e_tag: string | null
}

export interface MetaTable {
  key: 'version'
  value: string
}

export interface Database {
  cache_keys: CacheKeysTable
  uploads: UploadsTable
  upload_parts: UploadPartsTable
  meta: MetaTable
}

let _db: Kysely<Database>

export async function initializeDatabase() {
  const driverName = ENV.DB_DRIVER
  const driverSetup = getDatabaseDriver(driverName)
  if (!driverSetup) {
    logger.error(`No database driver found for ${driverName}`)
    // eslint-disable-next-line unicorn/no-process-exit
    process.exit(1)
  }
  logger.info(`Using database driver: ${driverName}`)

  const driver = await driverSetup()

  _db = new Kysely<Database>({
    dialect: driver,
  })

  logger.info('Migrating database...')
  const migrator = new Migrator({
    db: _db,
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
}

export function useDB() {
  return _db
}

type DB = typeof _db

/**
 * @see https://docs.github.com/en/actions/using-workflows/caching-dependencies-to-speed-up-workflows#matching-a-cache-key
 */
export async function findKeyMatch(
  db: DB,
  args: { key: string; version: string; restoreKeys?: string[] },
) {
  logger.debug('Finding key match', args)
  const exactPrimaryMatch = await db
    .selectFrom('cache_keys')
    .where('id', '=', getCacheKeyId(args.key, args.version))
    .selectAll()
    .executeTakeFirst()
  if (exactPrimaryMatch) {
    return exactPrimaryMatch
  }

  logger.debug('No exact primary matches found')

  const prefixedPrimaryMatch = await db
    .selectFrom('cache_keys')
    .where('key', 'like', `${args.key}%`)
    .where('version', '=', args.version)
    .orderBy('cache_keys.updated_at desc')
    .selectAll()
    .executeTakeFirst()

  if (prefixedPrimaryMatch) {
    return prefixedPrimaryMatch
  }

  if (!args.restoreKeys) {
    logger.debug('No restore keys provided')
    return
  }

  logger.debug('Trying restore keys', args.restoreKeys)
  for (const key of args.restoreKeys) {
    const exactMatch = await db
      .selectFrom('cache_keys')
      .where('id', '=', getCacheKeyId(key, args.version))
      .orderBy('cache_keys.updated_at desc')
      .selectAll()
      .executeTakeFirst()
    if (exactMatch) {
      return exactMatch
    }

    logger.debug('No exact matches found for', key)

    const prefixedMatch = await db
      .selectFrom('cache_keys')
      .where('version', '=', args.version)
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

export async function updateOrCreateKey(
  db: DB,
  {
    key,
    version,
    date,
  }: {
    key: string
    version: string
    date?: Date
  },
) {
  const now = date ?? new Date()
  const updateResult = await db
    .updateTable('cache_keys')
    .set('updated_at', now.toISOString())
    .set('accessed_at', now.toISOString())
    .where('id', '=', getCacheKeyId(key, version))
    .executeTakeFirst()
  if (Number(updateResult.numUpdatedRows) === 0) {
    await createKey(db, { key, version, date })
  }
}

export async function touchKey(
  db: DB,
  { key, version, date }: { key: string; version: string; date?: Date },
) {
  const now = date ?? new Date()
  await db
    .updateTable('cache_keys')
    .set('accessed_at', now.toISOString())
    .where('id', '=', getCacheKeyId(key, version))
    .execute()
}

export async function findStaleKeys(
  db: DB,
  { olderThanDays, date }: { olderThanDays?: number; date?: Date },
) {
  if (olderThanDays === undefined) return db.selectFrom('cache_keys').selectAll().execute()

  const now = date ?? new Date()
  const threshold = new Date(now.getTime() - olderThanDays * 24 * 60 * 60 * 1000)
  return db
    .selectFrom('cache_keys')
    .where('accessed_at', '<', threshold.toISOString())
    .selectAll()
    .execute()
}

export async function createKey(
  db: DB,
  { key, version, date }: { key: string; version: string; date?: Date },
) {
  const now = date ?? new Date()
  await db
    .insertInto('cache_keys')
    .values({
      id: getCacheKeyId(key, version),
      key,
      version,
      updated_at: now.toISOString(),
      accessed_at: now.toISOString(),
    })
    .execute()
}

function getCacheKeyId(key: string, version: string) {
  return hash('sha256', Buffer.from(`${key}-${version}`))
}

export async function pruneKeys(db: DB, keys?: Selectable<CacheKeysTable>[]) {
  if (keys) {
    await db.transaction().execute(async (tx) => {
      for (const { key, version } of keys ?? []) {
        await tx.deleteFrom('cache_keys').where('id', '=', getCacheKeyId(key, version)).execute()
      }
    })
  } else {
    await db.deleteFrom('cache_keys').execute()
  }
}

export async function uploadExists(db: DB, { key, version }: { key: string; version: string }) {
  const row = await db
    .selectFrom('uploads')
    .select('id')
    .where('key', '=', key)
    .where('version', '=', version)
    .executeTakeFirst()
  return !!row
}
