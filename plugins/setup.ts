import { H3Error } from 'h3'

import { initializeDatabase } from '~/lib/db'
import { ENV } from '~/lib/env'
import { logger } from '~/lib/logger'
import { initializeStorage } from '~/lib/storage'

export default defineNitroPlugin(async (nitro) => {
  logger.info(`🚀 Starting GitHub Actions Cache Server (${useRuntimeConfig().version})`)

  await initializeDatabase()
  await initializeStorage()

  nitro.hooks.hook('error', (error, { event }) => {
    if (!event) {
      logger.error(error)
      return
    }

    logger.error(
      `Response: ${event.method} ${obfuscateTokenFromPath(event.path)} > ${error instanceof H3Error ? error.statusCode : '[no status code]'}\n`,
      error,
    )
  })

  if (ENV.DEBUG) {
    nitro.hooks.hook('request', (event) => {
      logger.debug(`Request: ${event.method} ${obfuscateTokenFromPath(event.path)}`)
    })
    nitro.hooks.hook('afterResponse', (event) => {
      logger.debug(
        `Response: ${event.method} ${obfuscateTokenFromPath(event.path)} > ${getResponseStatus(event)}`,
      )
    })
  }

  if (process.send) process.send('nitro:ready')
})

function obfuscateTokenFromPath(path: string) {
  const split = path.split('/_apis')
  if (split.length <= 1) return path
  return `/<secret_token>/_apis${split[1]}`
}
