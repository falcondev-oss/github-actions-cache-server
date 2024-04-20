import { PostgresDialect } from 'kysely'
import pg from 'pg'
import { z } from 'zod'

import { defineDatabaseDriver } from '~/lib/db/driver'

export const postgresDriver = defineDatabaseDriver({
  envSchema: z.object({
    DB_POSTGRES_DATABASE: z.string(),
    DB_POSTGRES_HOST: z.string(),
    DB_POSTGRES_USER: z.string(),
    DB_POSTGRES_PASSWORD: z.string(),
    DB_POSTGRES_PORT: z.coerce.number().int(),
  }),
  async setup({
    DB_POSTGRES_DATABASE,
    DB_POSTGRES_HOST,
    DB_POSTGRES_PASSWORD,
    DB_POSTGRES_PORT,
    DB_POSTGRES_USER,
  }) {
    const pool = new pg.Pool({
      database: DB_POSTGRES_DATABASE,
      host: DB_POSTGRES_HOST,
      password: DB_POSTGRES_PASSWORD,
      port: DB_POSTGRES_PORT,
      user: DB_POSTGRES_USER,
      max: 10,
    })
    await pool.connect()
    return new PostgresDialect({
      pool,
    })
  },
})
