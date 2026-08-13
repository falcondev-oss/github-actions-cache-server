import { env } from '~/lib/env'
import { logger } from '~/lib/logger'
import { redactSignedPath } from '~/lib/url-signing'

export default defineEventHandler(async (event) => {
  logger.debug(
    'proxying unknown path',
    redactSignedPath(event.path),
    'to',
    env.DEFAULT_ACTIONS_RESULTS_URL,
  )
  return proxyRequest(event, `${env.DEFAULT_ACTIONS_RESULTS_URL}${event.path}`)
})
