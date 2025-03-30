import { logger } from '~/lib/logger'

const DEFAULT_ACTIONS_RESULTS_URL = 'https://results-receiver.actions.githubusercontent.com'

export default defineEventHandler(async (event) => {
  logger.debug('proxying unknown path', event.path, 'to', DEFAULT_ACTIONS_RESULTS_URL)
  return proxyRequest(event, `${DEFAULT_ACTIONS_RESULTS_URL}${event.path}`)
})
