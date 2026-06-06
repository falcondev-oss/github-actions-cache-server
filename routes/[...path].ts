import { fetch as undiciFetch } from 'undici'
import { env } from '~/lib/env'
import { logger } from '~/lib/logger'
import { getProxyDispatcher } from '~/lib/proxy-agent'

export default defineEventHandler(async (event) => {
  const upstream = env.DEFAULT_ACTIONS_RESULTS_URL
  const targetUrl = `${upstream}${event.path}`

  logger.debug('proxying unknown path', event.path, 'to', upstream)

  const fetchOptions: Record<string, unknown> = {}
  const dispatcher = getProxyDispatcher(targetUrl)
  if (dispatcher) {
    fetchOptions.dispatcher = dispatcher
  }

  return proxyRequest(event, targetUrl, { fetch: undiciFetch, fetchOptions })
})
