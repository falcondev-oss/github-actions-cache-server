import { ENV } from '~/lib/env'
import { logger } from '~/lib/logger'

// eslint-disable-next-line ts/no-misused-promises
export default defineNitroPlugin(async (nitro) => {
  await import('~/lib/env')
  await import('~/lib/db')

  nitro.hooks.hook('error', (error) => {
    logger.error(error)
  })

  if (ENV.DEBUG) {
    nitro.hooks.hook('request', (event) => {
      logger.debug(`Request: ${event.method} ${obfuscateTokenFromPath(event.path)}`)
    })
    nitro.hooks.hook('beforeResponse', (event) => {
      logger.debug(
        `Response: ${event.method} ${obfuscateTokenFromPath(event.path)} > ${event.node.res.statusCode}`,
      )
    })
  }
})

function obfuscateTokenFromPath(path: string) {
  const split = path.split('/_apis')
  if (split.length <= 1) return path
  return `/<secret_token>/_apis${split[1]}`
}
