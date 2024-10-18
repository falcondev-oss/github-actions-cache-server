import { PostgresDialect } from 'kysely'
import pg from 'pg'
import { z } from 'zod'

import { defineDatabaseDriver } from '~/lib/db/defineDatabaseDriver'

export const postgresDriver = defineDatabaseDriver({
  envSchema: z
    .object({
      DB_POSTGRES_DATABASE: z.string(),
      DB_POSTGRES_HOST: z.string(),
      DB_POSTGRES_USER: z.string(),
      DB_POSTGRES_PASSWORD: z.string(),
      DB_POSTGRES_PORT: z.coerce.number().int(),
    })
    .or(
      z.object({
        DB_POSTGRES_URL: z.string(),
      }),
    ),
  async setup(options) {
    const pool = new pg.Pool(
      'DB_POSTGRES_URL' in options
        ? {
            connectionString: options.DB_POSTGRES_URL,
          }
        : {
            database: options.DB_POSTGRES_DATABASE,
            host: options.DB_POSTGRES_HOST,
            password: options.DB_POSTGRES_PASSWORD,
            port: options.DB_POSTGRES_PORT,
            user: options.DB_POSTGRES_USER,
            max: 10,
          },
    )
    await pool.connect()
    return new PostgresDialect({
      pool,
    })
  },
})
