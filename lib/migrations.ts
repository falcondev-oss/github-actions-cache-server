import type { Migration } from 'kysely'
import type { Env } from './schemas'
import { Storage } from './storage'

export function migrations(driver: Env['DB_DRIVER']) {
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

        // clear all existing entries
        const adapter = await Storage.getAdapterFromEnv()

        await Promise.all([
          db.deleteFrom('cache_entries').execute(),
          db.deleteFrom('storage_locations').execute(),
          db.deleteFrom('uploads').execute(),
          adapter.clear(),
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
        await db.schema.dropIndex('idx_cache_entries_scope').execute()
        await db.schema.alterTable('cache_entries').dropColumn('scope').execute()
        await db.schema.dropIndex('idx_uploads_scope').execute()
        await db.schema.alterTable('uploads').dropColumn('scope').execute()
      },
    },
  } satisfies Record<string, Migration>
}
