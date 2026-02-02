import type { H3Event } from 'h3'
import { env } from '~/lib/env'
import { getMetrics } from '~/lib/metrics'

const REQUEST_START_TIME = Symbol('requestStartTime')

declare module 'h3' {
  interface H3Event {
    [REQUEST_START_TIME]?: number
  }
}

function normalizeRoute(path: string): string {
  // Normalize dynamic route segments to prevent high cardinality
  return path
    .replace(/\/download\/[^/]+/, '/download/:cacheEntryId')
    .replace(/\/upload\/[^/]+/, '/upload/:uploadId')
}

function getStatusClass(status: number): string {
  if (status >= 500) return '5xx'
  if (status >= 400) return '4xx'
  if (status >= 300) return '3xx'
  if (status >= 200) return '2xx'
  return '1xx'
}

export default defineNitroPlugin(async (nitro) => {
  if (!env.METRICS_ENABLED) return

  const metrics = await getMetrics()
  if (!metrics) return

  nitro.hooks.hook('request', (event: H3Event) => {
    event[REQUEST_START_TIME] = performance.now()
  })

  nitro.hooks.hook('afterResponse', (event: H3Event) => {
    const startTime = event[REQUEST_START_TIME]
    if (startTime === undefined) return

    const duration = (performance.now() - startTime) / 1000 // Convert to seconds
    const status = getResponseStatus(event)
    const route = normalizeRoute(event.path)
    const method = event.method

    // Skip metrics endpoint itself to avoid recursion
    if (route === '/metrics') return

    metrics.httpRequestDuration.record(duration, {
      method,
      route,
      status: String(status),
    })

    metrics.httpRequestsTotal.add(1, {
      method,
      route,
      status_class: getStatusClass(status),
    })
  })

  nitro.hooks.hook('error', (_error, { event }) => {
    if (!event) return

    const startTime = event[REQUEST_START_TIME]
    if (startTime === undefined) return

    const duration = (performance.now() - startTime) / 1000
    const route = normalizeRoute(event.path)
    const method = event.method

    // Record error with 500 status
    metrics.httpRequestDuration.record(duration, {
      method,
      route,
      status: '500',
    })

    metrics.httpRequestsTotal.add(1, {
      method,
      route,
      status_class: '5xx',
    })
  })
})
