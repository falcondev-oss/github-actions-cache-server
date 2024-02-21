import { primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const CacheKeys = sqliteTable(
  'cache_keys',
  {
    key: text('key').notNull(),
    version: text('version').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.key, t.version] }),
  }),
)
