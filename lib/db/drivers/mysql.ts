import { MysqlDialect } from 'kysely'
import { createPool } from 'mysql2'
import { z } from 'zod'

import { defineDatabaseDriver } from '~/lib/db/defineDatabaseDriver'

export const mysqlDriver = defineDatabaseDriver({
  envSchema: z.object({
    DB_MYSQL_DATABASE: z.string(),
    DB_MYSQL_HOST: z.string(),
    DB_MYSQL_USER: z.string(),
    DB_MYSQL_PASSWORD: z.string(),
    DB_MYSQL_PORT: z.coerce.number().int(),
  }),
  async setup({
    DB_MYSQL_DATABASE,
    DB_MYSQL_HOST,
    DB_MYSQL_PASSWORD,
    DB_MYSQL_PORT,
    DB_MYSQL_USER,
  }) {
    const pool = createPool({
      database: DB_MYSQL_DATABASE,
      host: DB_MYSQL_HOST,
      password: DB_MYSQL_PASSWORD,
      port: DB_MYSQL_PORT,
      user: DB_MYSQL_USER,
      connectionLimit: 10,
    })
    return new MysqlDialect({
      pool,
    })
  },
})
