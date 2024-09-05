import { colorize } from 'consola/utils'
import { Cron } from 'croner'

import { useStorageAdapter } from '~/lib/storage'

import { ENV } from '@/lib/env'
import { logger } from '@/lib/logger'

export default defineNitroPlugin(() => {
  if (ENV.CLEANUP_OLDER_THAN_DAYS === 0) return

  const job = Cron('0 0 * * *') // daily
  const nextRun = job.nextRun()
  logger.info(
    `Cleaning up cache entries older than ${colorize('blue', `${ENV.CLEANUP_OLDER_THAN_DAYS}d`)} with schedule ${colorize('blue', job.getPattern() ?? '')}${nextRun ? ` (next run: ${nextRun.toLocaleString()})` : ''}`,
  )
  job.schedule(async () => {
    await useStorageAdapter().pruneCaches(ENV.CLEANUP_OLDER_THAN_DAYS)
  })
})
