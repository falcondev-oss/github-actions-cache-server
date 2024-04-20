import { mysqlDriver } from '~/db-drivers/mysql'
import { postgresDriver } from '~/db-drivers/postgres'
import { sqliteDriver } from '~/db-drivers/sqlite'
import type { defineDatabaseDriver } from '~/lib/db/driver'

const databaseDrivers: Record<string, ReturnType<typeof defineDatabaseDriver>> = {
  sqlite: sqliteDriver,
  postgres: postgresDriver,
  mysql: mysqlDriver,
}

export function getDatabaseDriver(name: string) {
  return databaseDrivers[name.toLowerCase()]
}
