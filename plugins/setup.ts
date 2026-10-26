/* eslint-disable unicorn/no-process-exit */
import cluster from 'node:cluster'

import { getDatabase } from '~/lib/db'
import { logger } from '~/lib/logger'
import { getStorage } from '~/lib/storage'

export default defineNitroPlugin(async (nitro) => {
  const version = useRuntimeConfig().version
  if (cluster.isPrimary) {
    logger.info(`🚀 Starting GitHub Actions Cache Server (${version})`)

    for (const signal of ['SIGTERM', 'SIGINT'] satisfies NodeJS.Signals[]) {
      process.on(signal, () => {
        const workers = Object.values(cluster.workers ?? {})
        for (const worker of workers) {
          worker?.process.kill(signal)
        }
      })
    }
  }

  await getDatabase().catch((err) => {
    logger.error('Failed to initialize database:', err)
    process.exit(1)
  })
  const storage = await getStorage().catch((err) => {
    logger.error('Failed to initialize storage:', err)
    process.exit(1)
  })

  nitro.hooks.hook('close', async () => {
    await storage.waitForOngoingMerges()
  })

  if (process.send && cluster.isPrimary) process.send('nitro:ready')
})
