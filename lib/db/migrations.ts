import { type Migration, sql } from 'kysely'

import type { DatabaseDriverName } from '~/lib/db/drivers'

export function migrations(dbType: DatabaseDriverName) {
  return {
    '2024-04-20T11:18:44': {
      async up(db) {
        let query = db.schema
          .createTable('cache_keys')
          .addColumn('key', dbType === 'mysql' ? 'varchar(512)' : 'text', (col) => col.notNull())
          .addColumn('version', dbType === 'mysql' ? 'varchar(512)' : 'text', (col) =>
            col.notNull(),
          )
          .addColumn('updated_at', 'text', (col) => col.notNull())
          .addColumn('accessed_at', 'text', (col) => col.notNull())
          .addPrimaryKeyConstraint('pk', ['key', 'version'])

        if (dbType === 'mysql') query = query.modifyEnd(sql`engine=InnoDB CHARSET=latin1`)

        await query.ifNotExists().execute()
      },
      async down(db) {
        await db.schema.dropTable('cache_keys').ifExists().execute()
      },
    },
    '2024-10-15T16:39:29': {
      async up(db) {
        await db.schema
          .createTable('uploads')
          .addColumn('created_at', 'text', (col) => col.notNull())
          .addColumn('key', 'text', (col) => col.notNull())
          .addColumn('version', 'text', (col) => col.notNull())
          .addColumn('driver_upload_id', 'text', (col) => col.notNull())
          .addColumn('id', 'integer', (col) => col.notNull())
          .addPrimaryKeyConstraint('pk', ['id'])
          .addUniqueConstraint('key_version', ['key', 'version'])
          .ifNotExists()
          .execute()
        await db.schema
          .createTable('upload_parts')
          .addColumn('upload_id', 'integer')
          .addColumn('part_number', 'integer')
          .addColumn('e_tag', 'text')
          .addPrimaryKeyConstraint('pk', ['upload_id', 'part_number'])
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
      },
    },
  } satisfies Record<string, Migration>
}
