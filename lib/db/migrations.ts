import { type Migration, sql } from 'kysely'

export const migrations = (dbType: 'postgres' | 'sqlite' | 'mysql') =>
  ({
    '2024-04-20T11:18:44': {
      async up(db) {
        const query = db.schema
          .createTable('cache_keys')
          .addColumn('key', dbType === 'mysql' ? 'varchar(512)' : 'text', (col) => col.notNull())
          .addColumn('version', dbType === 'mysql' ? 'varchar(512)' : 'text', (col) =>
            col.notNull(),
          )
          .addColumn('updated_at', 'text', (col) => col.notNull())
          .addPrimaryKeyConstraint('pk', ['key', 'version'])

        if (dbType === 'mysql') query.modifyEnd(sql`engine=InnoDB CHARSET=latin1`)

        await query.ifNotExists().execute()
      },
      async down(db) {
        await db.schema.dropTable('cache_keys').ifExists().execute()
      },
    },
  }) satisfies Record<string, Migration>
