import { createSingletonPromise } from '@antfu/utils'
import { metrics } from '@opentelemetry/api'
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus'
import { MeterProvider } from '@opentelemetry/sdk-metrics'

import { env } from './env'

export const getMetrics = createSingletonPromise(async () => {
  if (!env.METRICS_ENABLED) return null

  const exporter = new PrometheusExporter({ preventServerStart: true })
  const meterProvider = new MeterProvider({
    readers: [exporter],
  })
  metrics.setGlobalMeterProvider(meterProvider)

  const meter = meterProvider.getMeter('github-actions-cache-server')

  // HTTP Metrics
  const httpRequestDuration = meter.createHistogram('http_request_duration_seconds', {
    description: 'HTTP request latency in seconds',
    unit: 's',
  })

  const httpRequestsTotal = meter.createCounter('http_requests_total', {
    description: 'Total number of HTTP requests',
  })

  // Cache Metrics
  const cacheOperationsTotal = meter.createCounter('cache_operations_total', {
    description: 'Total cache operations (hit/miss/create)',
  })

  // Storage Metrics
  const storageOperationsTotal = meter.createCounter('storage_operations_total', {
    description: 'Total storage adapter operations',
  })

  const storageOperationDuration = meter.createHistogram('storage_operation_duration_seconds', {
    description: 'Storage operation latency in seconds',
    unit: 's',
  })

  // Database Metrics
  const dbQueryDuration = meter.createHistogram('db_query_duration_seconds', {
    description: 'Database query latency in seconds',
    unit: 's',
  })

  const dbQueriesTotal = meter.createCounter('db_queries_total', {
    description: 'Total database queries',
  })

  // Byte Transfer Metrics
  const cacheBytesUploadedTotal = meter.createCounter('cache_bytes_uploaded_total', {
    description: 'Total cache data uploaded in bytes',
    unit: 'By',
  })

  const cacheBytesDownloadedTotal = meter.createCounter('cache_bytes_downloaded_total', {
    description: 'Total cache data downloaded in bytes',
    unit: 'By',
  })

  return {
    exporter,
    meter,
    httpRequestDuration,
    httpRequestsTotal,
    cacheOperationsTotal,
    storageOperationsTotal,
    storageOperationDuration,
    dbQueryDuration,
    dbQueriesTotal,
    cacheBytesUploadedTotal,
    cacheBytesDownloadedTotal,
  }
})

export type Metrics = NonNullable<Awaited<ReturnType<typeof getMetrics>>>
