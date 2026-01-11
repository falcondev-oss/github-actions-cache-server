import { createSingletonPromise } from '@antfu/utils'
import { Kysely, Migrator, PostgresDialect } from 'kysely'
import pg from 'pg'
import { ENV } from './env'
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
  id: string
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

export const getDatabase = createSingletonPromise(async () => {
  const pool = new pg.Pool({
    connectionString: ENV.DB_POSTGRES_URL,
  })
  const db = new Kysely<Database>({
    dialect: new PostgresDialect({
      pool,
    }),
  })
  const migrator = new Migrator({
    db,
    provider: {
      async getMigrations() {
        return migrations()
      },
    },
  })
  await migrator.migrateToLatest()

  return db
})
