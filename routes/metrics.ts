import { metricsRegistry } from '~/lib/metrics'

export default defineEventHandler(async (event) => {
  setHeader(event, 'Content-Type', metricsRegistry.contentType)
  return await metricsRegistry.metrics()
})
