import { env } from '~/lib/env'
import { pathWithoutQuery } from '~/lib/helpers'
import { logger } from '~/lib/logger'

export default defineEventHandler(async (event) => {
  logger.debug(
    'proxying unknown path',
    pathWithoutQuery(event),
    'to',
    env.DEFAULT_ACTIONS_RESULTS_URL,
  )
  return proxyRequest(event, `${env.DEFAULT_ACTIONS_RESULTS_URL}${event.path}`)
})
