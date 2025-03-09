import cluster from 'node:cluster'
import { ENV } from '@/lib/env'
import { logger } from '@/lib/logger'

import { colorize } from 'consola/utils'

import { Cron } from 'croner'
import { useStorageAdapter } from '~/lib/storage'

export default defineNitroPlugin(() => {
  if (!cluster.isPrimary) return

  // cache cleanup
  if (ENV.CACHE_CLEANUP_OLDER_THAN_DAYS > 0) {
    const job = new Cron(ENV.CACHE_CLEANUP_CRON)
    const nextRun = job.nextRun()
    logger.info(
      `Cleaning up cache entries older than ${colorize('blue', `${ENV.CACHE_CLEANUP_OLDER_THAN_DAYS}d`)} with schedule ${colorize('blue', job.getPattern() ?? '')}${nextRun ? ` (next run: ${nextRun.toLocaleString()})` : ''}`,
    )
    job.schedule(async () => {
      const adapter = await useStorageAdapter()
      await adapter.pruneCaches(ENV.CACHE_CLEANUP_OLDER_THAN_DAYS)
    })
  }

  // upload cleanup
  const job = new Cron(ENV.UPLOAD_CLEANUP_CRON)
  const nextRun = job.nextRun()
  logger.info(
    `Cleaning up dangling uploads with schedule ${colorize('blue', job.getPattern() ?? '')}${nextRun ? ` (next run: ${nextRun.toLocaleString()})` : ''}`,
  )
  let lastRun = new Date()
  job.schedule(async () => {
    const adapter = await useStorageAdapter()
    await adapter.pruneUploads(lastRun)
    lastRun = new Date()
  })
})
