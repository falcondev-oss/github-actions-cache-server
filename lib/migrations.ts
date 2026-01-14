import type { Migration } from 'kysely'
import type { Env } from './schemas'

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
  } satisfies Record<string, Migration>
}
