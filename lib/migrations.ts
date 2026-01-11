import type { Migration } from 'kysely'

export function migrations() {
  return {
    $0_init: {
      async up(db) {
        await db.schema
          .createTable('storage_locations')
          .addColumn('id', 'text', (col) => col.primaryKey())
          .addColumn('folderName', 'text', (col) => col.notNull())
          .addColumn('partCount', 'integer', (col) => col.notNull())
          .addColumn('mergeStartedAt', 'bigint')
          .addColumn('mergedAt', 'bigint')
          .addColumn('partsDeletedAt', 'bigint')
          .addColumn('lastDownloadedAt', 'bigint')
          .execute()

        await db.schema
          .createTable('cache_entries')
          .addColumn('id', 'text', (col) => col.primaryKey())
          .addColumn('key', 'text', (col) => col.notNull())
          .addColumn('version', 'text', (col) => col.notNull())
          .addColumn('updatedAt', 'bigint', (col) => col.notNull())
          .addColumn('locationId', 'text', (col) =>
            col.notNull().references('storage_locations.id').onDelete('cascade'),
          )
          .execute()

        await db.schema
          .createTable('uploads')
          .addColumn('id', 'text', (col) => col.primaryKey())
          .addColumn('key', 'text', (col) => col.notNull())
          .addColumn('version', 'text', (col) => col.notNull())
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
