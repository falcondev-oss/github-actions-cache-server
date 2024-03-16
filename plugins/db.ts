import { migrate } from 'drizzle-orm/better-sqlite3/migrator'

import { db } from '@/db/client'
import { logger } from '@/utils/logger'

export default defineNitroPlugin(async () => {
  logger.info('Migrating database...')
  await migrate(db, { migrationsFolder: './db/migrations' })
  logger.success('Database migration complete')
})
