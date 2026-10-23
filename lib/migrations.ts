import type { Hookable } from 'hookable'
import type { Kysely } from 'kysely'
import type { Migration } from 'kysely/migration'
import type { Env } from './schemas'
import { sql } from 'kysely'
import { reservationHash } from './helpers'
import { Storage } from './storage'

export function migrations(
  driver: Env['DB_DRIVER'],
  hooks: Hookable<{
    afterMigrate: () => Promise<void>
  }>,
) {
  // MySQL requires `DROP INDEX ... ON table`, other drivers reject it
  async function dropIndex(db: Kysely<unknown>, index: string, table: string) {
    const query = db.schema.dropIndex(index)
    await (driver === 'mysql' ? query.on(table) : query).execute()
  }

  return {
    $0_init: {
      async up(db) {
        const idType = driver === 'mysql' ? 'varchar(36)' : 'text'
        await db.schema
          .createTable('storage_locations')
          .addColumn('id', idType, (col) => col.primaryKey())
          .addColumn('folderName', 'text', (col) => col.notNull())
          .addColumn('partCount', 'integer', (col) => col.notNull())
          .addColumn('mergeStartedAt', 'bigint')
          .addColumn('mergedAt', 'bigint')
          .addColumn('partsDeletedAt', 'bigint')
          .addColumn('lastDownloadedAt', 'bigint')
          .execute()

        await db.schema
          .createTable('cache_entries')
          .addColumn('id', idType, (col) => col.primaryKey())
          .addColumn('key', driver === 'mysql' ? 'varchar(512)' : 'text', (col) => col.notNull())
          .addColumn('version', driver === 'mysql' ? 'varchar(255)' : 'text', (col) =>
            col.notNull(),
          )
          .addColumn('updatedAt', 'bigint', (col) => col.notNull())
          .addColumn('locationId', idType, (col) =>
            col.notNull().references('storage_locations.id').onDelete('cascade'),
          )
          .execute()

        await db.schema
          .createTable('uploads')
          .addColumn('id', 'bigint', (col) => col.primaryKey())
          .addColumn('key', driver === 'mysql' ? 'varchar(512)' : 'text', (col) => col.notNull())
          .addColumn('version', driver === 'mysql' ? 'varchar(255)' : 'text', (col) =>
            col.notNull(),
          )
          .addColumn('createdAt', 'bigint', (col) => col.notNull())
          .addColumn('lastPartUploadedAt', 'bigint')
          .addColumn('folderName', 'text', (col) => col.notNull())
          .execute()

        await db.schema
          .createIndex('idx_cache_entries_key_version')
          .on('cache_entries')
          .columns(['key', 'version'])
          .execute()

        await db.schema
          .createIndex('idx_uploads_key_version')
          .on('uploads')
          .columns(['key', 'version'])
          .execute()
      },
      async down(db) {
        await db.schema.dropTable('uploads').execute()
        await db.schema.dropTable('cache_entries').execute()
        await db.schema.dropTable('storage_locations').execute()
      },
    },
    $1_upload_part_counts: {
      async up(db) {
        await db.schema
          .alterTable('uploads')
          .addColumn('finishedPartUploadCount', 'integer', (col) => col.notNull().defaultTo(0))
          .execute()
        await db.schema
          .alterTable('uploads')
          .addColumn('startedPartUploadCount', 'integer', (col) => col.notNull().defaultTo(0))
          .execute()
      },
      async down(db) {
        await db.schema.alterTable('uploads').dropColumn('startedPartUploadCount').execute()
        await db.schema.alterTable('uploads').dropColumn('finishedPartUploadCount').execute()
      },
    },
    $2_scopes: {
      async up(db) {
        const scopeColumnType = driver === 'mysql' ? 'varchar(255)' : 'text'

        await Promise.all([
          db.deleteFrom('cache_entries').execute(),
          db.deleteFrom('storage_locations').execute(),
          db.deleteFrom('uploads').execute(),
        ])

        await db.schema
          .alterTable('cache_entries')
          .addColumn('scope', scopeColumnType, (col) => col.notNull())
          .execute()
        await db.schema
          .createIndex('idx_cache_entries_scope')
          .on('cache_entries')
          .columns(['scope'])
          .execute()

        await db.schema
          .alterTable('uploads')
          .addColumn('scope', scopeColumnType, (col) => col.notNull())
          .execute()
        await db.schema.createIndex('idx_uploads_scope').on('uploads').columns(['scope']).execute()
      },
      async down(db) {
        await dropIndex(db, 'idx_cache_entries_scope', 'cache_entries')
        await db.schema.alterTable('cache_entries').dropColumn('scope').execute()
        await dropIndex(db, 'idx_uploads_scope', 'uploads')
        await db.schema.alterTable('uploads').dropColumn('scope').execute()
      },
    },
    $3_repoId: {
      async up(db) {
        const repoIdColumnType = driver === 'mysql' ? 'varchar(255)' : 'text'

        await Promise.all([
          db.deleteFrom('cache_entries').execute(),
          db.deleteFrom('storage_locations').execute(),
          db.deleteFrom('uploads').execute(),
        ])

        hooks.hook('afterMigrate', async () => {
          const adapter = await Storage.getAdapterFromEnv()
          await adapter.clear()
        })

        await db.schema
          .alterTable('cache_entries')
          .addColumn('repoId', repoIdColumnType, (col) => col.notNull())
          .execute()
        await db.schema
          .createIndex('idx_cache_entries_repoId')
          .on('cache_entries')
          .columns(['repoId'])
          .execute()

        await db.schema
          .alterTable('uploads')
          .addColumn('repoId', repoIdColumnType, (col) => col.notNull())
          .execute()
        await db.schema
          .createIndex('idx_uploads_repoId')
          .on('uploads')
          .columns(['repoId'])
          .execute()
      },
      async down(db) {
        await dropIndex(db, 'idx_cache_entries_repoId', 'cache_entries')
        await db.schema.alterTable('cache_entries').dropColumn('repoId').execute()
        await dropIndex(db, 'idx_uploads_repoId', 'uploads')
        await db.schema.alterTable('uploads').dropColumn('repoId').execute()
      },
    },
    $4_storage_leases: {
      async up(db) {
        const idType = driver === 'mysql' ? 'varchar(36)' : 'text'
        const scopeType = driver === 'mysql' ? 'varchar(16)' : 'text'

        await db.schema
          .createTable('merge_leases')
          .addColumn('storageLocationId', idType, (col) =>
            col.primaryKey().references('storage_locations.id').onDelete('cascade'),
          )
          .addColumn('token', idType, (col) => col.notNull())
          .addColumn('expiresAt', 'bigint', (col) => col.notNull())
          .execute()

        await db.schema
          .createTable('storage_reader_leases')
          .addColumn('id', idType, (col) => col.primaryKey())
          .addColumn('storageLocationId', idType, (col) =>
            col.notNull().references('storage_locations.id').onDelete('cascade'),
          )
          .addColumn('scope', scopeType, (col) => col.notNull())
          .addColumn('expiresAt', 'bigint', (col) => col.notNull())
          .execute()

        await db.schema
          .createIndex('idx_storage_reader_leases_location_expiry')
          .on('storage_reader_leases')
          .columns(['storageLocationId', 'expiresAt'])
          .execute()
      },
      async down(db) {
        await db.schema.dropTable('storage_reader_leases').execute()
        await db.schema.dropTable('merge_leases').execute()
      },
    },
    $5_storage_location_sizes: {
      async up(db) {
        await db.schema.alterTable('storage_locations').addColumn('sizeBytes', 'bigint').execute()
      },
      async down(db) {
        await db.schema.alterTable('storage_locations').dropColumn('sizeBytes').execute()
      },
    },
    $6_cache_entries_locationId_index: {
      async up(db) {
        await db.schema
          .createIndex('idx_cache_entries_locationId')
          .on('cache_entries')
          .columns(['locationId'])
          .execute()
      },
      async down(db) {
        await dropIndex(db, 'idx_cache_entries_locationId', 'cache_entries')
      },
    },
    $7_uploads_reservationHash: {
      async up(db) {
        // A unique index over (key, version, scope, repoId) exceeds MySQL's
        // 3072-byte key limit, so it covers a fixed-width hash of the tuple.
        // Nullable so replicas still on the previous version can insert during a rollout.
        await db.schema.alterTable('uploads').addColumn('reservationHash', 'char(64)').execute()

        const uploads = await db
          .selectFrom('uploads')
          .select(['id', 'key', 'version', 'scope', 'repoId'])
          .orderBy('createdAt', 'desc')
          .execute()
        const seen = new Set<string>()
        for (const { id, ...reservation } of uploads) {
          const hash = reservationHash(reservation)
          // keep the newest upload per reservation, cleanup:orphaned-storage reclaims the rest's parts
          if (seen.has(hash)) {
            await db.deleteFrom('uploads').where('id', '=', id).execute()
            continue
          }
          seen.add(hash)
          await db
            .updateTable('uploads')
            .set({ reservationHash: hash })
            .where('id', '=', id)
            .execute()
        }

        await db.schema
          .createIndex('idx_uploads_reservationHash')
          .unique()
          .on('uploads')
          .column('reservationHash')
          .execute()
      },
      async down(db) {
        await dropIndex(db, 'idx_uploads_reservationHash', 'uploads')
        await db.schema.alterTable('uploads').dropColumn('reservationHash').execute()
      },
    },
    $8_exact_key_scope_collation: {
      // MySQL's default collation ignores case, accents and trailing spaces, GitHub compares exactly
      async up(db) {
        if (driver !== 'mysql') return
        for (const table of ['cache_entries', 'uploads'])
          await db.schema
            .alterTable(table)
            .modifyColumn('key', sql`varchar(512) collate utf8mb4_0900_bin`, (col) => col.notNull())
            .modifyColumn('scope', sql`varchar(255) collate utf8mb4_0900_bin`, (col) =>
              col.notNull(),
            )
            .execute()
      },
      async down(db) {
        if (driver !== 'mysql') return
        for (const table of ['cache_entries', 'uploads'])
          await db.schema
            .alterTable(table)
            .modifyColumn('key', 'varchar(512)', (col) => col.notNull())
            .modifyColumn('scope', 'varchar(255)', (col) => col.notNull())
            .execute()
      },
    },
  } satisfies Record<string, Migration>
}
