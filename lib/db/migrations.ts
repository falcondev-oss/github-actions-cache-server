import { type Migration, sql } from 'kysely'

import type { DatabaseDriverName } from '~/db-drivers'

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
  } satisfies Record<string, Migration>
}
