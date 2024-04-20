import SQLite from 'better-sqlite3'
import { SqliteDialect } from 'kysely'
import { z } from 'zod'

import { defineDatabaseDriver } from '@/lib/db/driver'

export const sqliteDriver = defineDatabaseDriver({
  envSchema: z.object({
    DB_SQLITE_PATH: z.string(),
  }),
  setup({ DB_SQLITE_PATH }) {
    return new SqliteDialect({
      database: new SQLite(DB_SQLITE_PATH),
    })
  },
})
