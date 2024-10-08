import { PostgresDialect } from 'kysely'
import pg from 'pg'
import { z } from 'zod'

import { defineDatabaseDriver } from '~/lib/db/driver'

export const postgresDriver = defineDatabaseDriver({
  envSchema: z.object({
    DB_POSTGRES_CONNECTION_STRING: z.string().optional(),
    DB_POSTGRES_DATABASE: z.string().optional(),
    DB_POSTGRES_HOST: z.string().optional(),
    DB_POSTGRES_USER: z.string().optional(),
    DB_POSTGRES_PASSWORD: z.string().optional(),
    DB_POSTGRES_PORT: z.coerce.number().int().optional(),
  }),
  async setup({
    DB_POSTGRES_CONNECTION_STRING,
    DB_POSTGRES_DATABASE,
    DB_POSTGRES_HOST,
    DB_POSTGRES_PASSWORD,
    DB_POSTGRES_PORT,
    DB_POSTGRES_USER,
  }) {
    const pool = new pg.Pool({
      connectionString: DB_POSTGRES_CONNECTION_STRING || undefined,
      database: DB_POSTGRES_DATABASE || undefined,
      host: DB_POSTGRES_HOST || undefined,
      password: DB_POSTGRES_PASSWORD || undefined,
      port: DB_POSTGRES_PORT || undefined,
      user: DB_POSTGRES_USER || undefined,
      max: 10,
    })
    await pool.connect()
    return new PostgresDialect({
      pool,
    })
  },
})
