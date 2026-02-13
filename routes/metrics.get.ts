import { env } from '~/lib/env'
import { getMetrics } from '~/lib/metrics'

export default defineEventHandler(async (event) => {
  if (!env.METRICS_ENABLED) {
    throw createError({
      statusCode: 404,
      statusMessage: 'Metrics endpoint is disabled',
    })
  }

  const metrics = await getMetrics()
  if (!metrics) {
    throw createError({
      statusCode: 503,
      statusMessage: 'Metrics not initialized',
    })
  }

  const { req, res } = event.node

  return new Promise<void>((resolve) => {
    res.on('finish', resolve)
    metrics.exporter.getMetricsRequestHandler(req, res)
  })
})
