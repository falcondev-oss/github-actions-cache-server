import cluster from 'node:cluster'
import { ENV } from '@/lib/env'
import { logger } from '@/lib/logger'

import { colorize } from 'consola/utils'

import { Cron } from 'croner'
import { useStorageAdapter } from '~/lib/storage'

export default defineNitroPlugin(() => {
  if (!cluster.isPrimary) return

  // cache cleanup
  if (
    ENV.CACHE_CLEANUP_OLDER_THAN_DAYS ||
    ENV.CACHE_CLEANUP_TTL_DAYS ||
    ENV.CACHE_CLEANUP_UNUSED_TTL_DAYS
  ) {
    const job = new Cron(ENV.CACHE_CLEANUP_CRON)
    const nextRun = job.nextRun()
    logger.info(
      `Cleaning up cache entries with schedule ${colorize('blue', job.getPattern() ?? '')}${nextRun ? ` (next run: ${nextRun.toLocaleString()})` : ''}`,
    )
    job.schedule(async () => {
      const adapter = await useStorageAdapter()
      await adapter.pruneCaches({
        ttlDays: ENV.CACHE_CLEANUP_TTL_DAYS,
        unusedTTLDays: ENV.CACHE_CLEANUP_UNUSED_TTL_DAYS ?? ENV.CACHE_CLEANUP_OLDER_THAN_DAYS,
      })
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
