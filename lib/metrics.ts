import { sql } from 'kysely'
import { collectDefaultMetrics, Counter, Gauge, Registry } from 'prom-client'
import { getDatabase } from './db'

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

// Computed at scrape time from the per-location payload sizes recorded at upload
// completion. Rows predating size tracking read as 0 until reconciled on the
// next startup. See ADR-0008.
export const cacheStorageBytes = new Gauge({
  name: 'cache_storage_bytes',
  help: 'Total bytes of finalized cache payloads tracked across storage locations.',
  registers: [metricsRegistry],
  async collect() {
    const db = await getDatabase()
    const { bytes } = await db
      .selectFrom('storage_locations')
      .select(sql<number>`coalesce(sum(${sql.ref('sizeBytes')}), 0)`.as('bytes'))
      .executeTakeFirstOrThrow()
    cacheStorageBytes.set(Number(bytes))
  },
})
