import { colorize } from 'consola/utils'
import { Cron } from 'croner'

import { ENV } from '@/lib/env'
import { logger } from '@/lib/logger'
import { storageAdapter } from '@/lib/storage'

export default defineNitroPlugin(() => {
  // daily
  const job = Cron('0 0 * * *')
  const nextRun = job.nextRun()
  logger.info(
    `Cleaning up cache entries older than ${colorize('blue', `${ENV.CLEANUP_OLDER_THAN_DAYS}d`)} with schedule ${colorize('blue', job.getPattern() ?? '')}${nextRun ? ` (next run: ${nextRun.toLocaleString()})` : ''}`,
  )
  job.schedule(async () => {
    await storageAdapter.pruneCaches(ENV.CLEANUP_OLDER_THAN_DAYS)
  })
})
