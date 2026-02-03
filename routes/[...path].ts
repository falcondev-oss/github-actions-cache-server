import { env } from '~/lib/env'
import { logger } from '~/lib/logger'

export default defineEventHandler(async (event) => {
  logger.debug('proxying unknown path', event.path, 'to', env.DEFAULT_ACTIONS_RESULTS_URL)
  return proxyRequest(event, `${env.DEFAULT_ACTIONS_RESULTS_URL}${event.path}`)
})
