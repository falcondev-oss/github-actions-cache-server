import { H3Error } from 'h3'
import { env } from '~/lib/env'
import { pathWithoutQuery } from '~/lib/helpers'
import { logger } from '~/lib/logger'

export default defineNitroPlugin((nitro) => {
  nitro.hooks.hook('error', (error, { event }) => {
    if (!event) {
      logger.error(error)
      return
    }

    logger.error(
      `Response: ${event.method} ${pathWithoutQuery(event)} > ${error instanceof H3Error ? error.statusCode : '[no status code]'}\n`,
      error,
    )
  })

  if (env.DEBUG) {
    nitro.hooks.hook('request', (event) => {
      logger.debug(`Request: ${event.method} ${pathWithoutQuery(event)}`)
    })
    nitro.hooks.hook('afterResponse', (event) => {
      logger.debug(
        `Response: ${event.method} ${pathWithoutQuery(event)} > ${getResponseStatus(event)}`,
      )
    })
  }
})
