import type { defineDatabaseDriver } from '~/lib/db/defineDatabaseDriver'
import { mysqlDriver } from '~/lib/db/drivers/mysql'
import { postgresDriver } from '~/lib/db/drivers/postgres'
import { sqliteDriver } from '~/lib/db/drivers/sqlite'

const databaseDrivers = {
  sqlite: sqliteDriver,
  postgres: postgresDriver,
  mysql: mysqlDriver,
} as const satisfies Record<string, ReturnType<typeof defineDatabaseDriver>>

export type DatabaseDriverName = keyof typeof databaseDrivers

export function getDatabaseDriver(name: string) {
  return databaseDrivers[name as DatabaseDriverName]
}
