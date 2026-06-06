import { fetch as undiciFetch } from 'undici'
import { env } from '~/lib/env'
import { logger } from '~/lib/logger'
import { getProxyDispatcher } from '~/lib/proxy-agent'

const SKIP_HEADERS = new Set([
  'content-length',
  'host',
  'connection',
  'keep-alive',
  'transfer-encoding',
])

export default defineEventHandler(async (event) => {
  const upstream = env.DEFAULT_ACTIONS_RESULTS_URL
  const targetUrl = `${upstream}${event.path}`

  try {
    logger.debug('proxying twirp path', event.path, 'to', upstream)

    const dispatcher = getProxyDispatcher(targetUrl)

    const headers: Record<string, string> = {}
    for (const [key, value] of Object.entries(getRequestHeaders(event))) {
      if (!SKIP_HEADERS.has(key.toLowerCase()) && typeof value === 'string') {
        headers[key] = value
      }
    }

    const body = await readRawBody(event, false).catch(() => undefined)
    const res = await undiciFetch(targetUrl, {
      method: event.method,
      headers,
      body: body || undefined,
      signal: AbortSignal.timeout(5000),
      ...(dispatcher ? { dispatcher } : {}),
    })

    setResponseStatus(event, res.status, res.statusText)
    for (const [key, value] of res.headers) {
      setResponseHeader(event, key, value)
    }
    return res.body
  } catch (err) {
    logger.warn(
      'twirp proxy failed for',
      event.path,
      '- returning stub 200',
      err,
    )

    const contentType =
      getRequestHeader(event, 'content-type') || 'application/protobuf'
    setResponseHeader(event, 'content-type', contentType)
    setResponseStatus(event, 200)
    return ''
  }
})
