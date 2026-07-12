import { collectDefaultMetrics, Counter, Registry } from 'prom-client'

// Per-process registry. Correct for the shipped single-worker-per-container
// topology (Dockerfile: NITRO_CLUSTER_WORKERS=1) — scale with replicas and
// aggregate in PromQL. NITRO_CLUSTER_WORKERS>1 makes these counters per-worker
// because workers share the port round-robin. See ADR-0007.
export const metricsRegistry = new Registry()

collectDefaultMetrics({ register: metricsRegistry })

export const cacheRequestsTotal = new Counter({
  name: 'cache_requests_total',
  help: 'Cache download-URL lookups by result. A restore-key prefix match counts as a hit.',
  labelNames: ['result'],
  registers: [metricsRegistry],
})
// Materialise both series at 0 so dashboards see them before the first event.
cacheRequestsTotal.inc({ result: 'hit' }, 0)
cacheRequestsTotal.inc({ result: 'miss' }, 0)

export const cacheUploadsTotal = new Counter({
  name: 'cache_uploads_total',
  help: 'Cache uploads finalized into cache entries.',
  registers: [metricsRegistry],
})
