import { mysqlDriver } from '~/db-drivers/mysql'
import { postgresDriver } from '~/db-drivers/postgres'
import { sqliteDriver } from '~/db-drivers/sqlite'
import type { defineDatabaseDriver } from '~/lib/db/driver'

const databaseDrivers = {
  sqlite: sqliteDriver,
  postgres: postgresDriver,
  mysql: mysqlDriver,
} as const satisfies Record<string, ReturnType<typeof defineDatabaseDriver>>

export type DatabaseDriverName = keyof typeof databaseDrivers

export function getDatabaseDriver(name: string) {
  return databaseDrivers[name as DatabaseDriverName]
}
