import cluster from 'node:cluster'

import { H3Error } from 'h3'
import { getDatabase } from '~/lib/db'
import { env } from '~/lib/env'
import { logger } from '~/lib/logger'
import { getStorage } from '~/lib/storage'

export default defineNitroPlugin(async (nitro) => {
  const version = useRuntimeConfig().version
  if (cluster.isPrimary) {
    logger.info(`🚀 Starting GitHub Actions Cache Server (${version})`)

    if (!globalThis.gc)
      logger.warn(
        'Garbage collection is not exposed. Start the process with `node --expose-gc` for improved memory usage under high load.',
      )
  }

  await getStorage()
  const db = await getDatabase()

  nitro.hooks.hook('close', async () => db.destroy())

  nitro.hooks.hook('error', (error, { event }) => {
    if (!event) {
      logger.error(error)
      return
    }

    logger.error(
      `Response: ${event.method} ${event.path} > ${error instanceof H3Error ? error.statusCode : '[no status code]'}\n`,
      error,
    )
  })

  if (env.DEBUG) {
    nitro.hooks.hook('request', (event) => {
      logger.debug(`Request: ${event.method} ${event.path}`)
    })
    nitro.hooks.hook('afterResponse', (event) => {
      logger.debug(`Response: ${event.method} ${event.path} > ${getResponseStatus(event)}`)
    })
  }

  if (process.send && cluster.isPrimary) process.send('nitro:ready')
})
