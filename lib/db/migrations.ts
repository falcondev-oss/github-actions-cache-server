import type { Kysely, Migration } from 'kysely'

import type { DatabaseDriverName } from '~/lib/db/drivers'
import { sql } from 'kysely'

async function createCacheKeysTable({
  db,
  dbType,
}: {
  db: Kysely<any>
  dbType: DatabaseDriverName
}) {
  let query = db.schema
    .createTable('cache_keys')
    .addColumn('id', 'varchar(255)', (col) => col.notNull().primaryKey())
    .addColumn('key', 'text', (col) => col.notNull())
    .addColumn('version', 'text', (col) => col.notNull())
    .addColumn('updated_at', 'text', (col) => col.notNull())
    .addColumn('accessed_at', 'text', (col) => col.notNull())

  if (dbType === 'mysql') query = query.modifyEnd(sql`engine=InnoDB CHARSET=latin1`)

  await query.ifNotExists().execute()
}

export function migrations(dbType: DatabaseDriverName) {
  return {
    $0_cache_keys_table: {
      async up(db) {
        await createCacheKeysTable({ db, dbType })
      },
      async down(db) {
        await db.schema.dropTable('cache_keys').ifExists().execute()
      },
    },
    $1_uploads_and_upload_parts_tables: {
      async up(db) {
        await db.schema
          .createTable('uploads')
          .addColumn('created_at', 'text', (col) => col.notNull())
          .addColumn('key', 'text', (col) => col.notNull())
          .addColumn('version', 'text', (col) => col.notNull())
          .addColumn('driver_upload_id', 'text', (col) => col.notNull())
          .addColumn('id', dbType === 'mysql' ? 'varchar(255)' : 'text', (col) =>
            col.notNull().primaryKey(),
          )
          .ifNotExists()
          .execute()
        await db.schema
          .createTable('upload_parts')
          .addColumn('upload_id', dbType === 'mysql' ? 'varchar(255)' : 'text')
          .addColumn('part_number', 'integer')
          .addColumn('e_tag', 'text')
          .addPrimaryKeyConstraint('pk_upload_parts', ['upload_id', 'part_number'])
          .addForeignKeyConstraint(
            'fk_upload_parts_uploads',
            ['upload_id'],
            'uploads',
            ['id'],
            (c) => c.onDelete('cascade'),
          )
          .ifNotExists()
          .execute()
      },
      async down(db) {
        await db.schema.dropTable('uploads').ifExists().execute()
        await db.schema.dropTable('upload_parts').ifExists().execute()
      },
    },
    $2_meta_table: {
      async up(db) {
        await db.schema
          .createTable('meta')
          .addColumn('key', dbType === 'mysql' ? 'varchar(255)' : 'text', (c) => c.primaryKey())
          .addColumn('value', 'text')
          .ifNotExists()
          .execute()
      },
      async down(db) {
        await db.schema.dropTable('meta').ifExists().execute()
      },
    },
    $3_remove_unused_columns: {
      async up(db) {
        await db.schema.alterTable('uploads').dropColumn('driver_upload_id').execute()
        await db.schema.alterTable('upload_parts').dropColumn('e_tag').execute()
      },
    },
    $4_cache_entry_created_at: {
      async up(db) {
        await db.schema.alterTable('cache_keys').addColumn('created_at', 'text').execute()

        await db
          .updateTable('cache_keys')
          .set({
            created_at: new Date().toISOString(),
          })
          .execute()

        if (dbType === 'mysql')
          await db.schema
            .alterTable('cache_keys')
            .modifyColumn('created_at', 'text', (c) => c.notNull())
            .execute()
        else if (dbType === 'postgres')
          await db.schema
            .alterTable('cache_keys')
            .alterColumn('created_at', (c) => c.setNotNull())
            .execute()
        else {
          // rename old table
          await db.schema.alterTable('cache_keys').renameTo('old_cache_keys').execute()
          // recreate table
          await createCacheKeysTable({ db, dbType })

          // add not null column
          await db.schema
            .alterTable('cache_keys')
            .addColumn('created_at', 'text', (c) => c.notNull())
            .execute()

          // migrate old data
          await db
            .insertInto('cache_keys')
            .expression((e) => e.selectFrom('old_cache_keys').selectAll())
            .execute()

          await db.schema.dropTable('old_cache_keys').execute()
        }
      },
    },
  } satisfies Record<string, Migration>
}
