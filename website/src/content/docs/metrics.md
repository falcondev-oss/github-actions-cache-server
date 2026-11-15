---
title: Metrics
description: 'Prometheus metrics for the self-hosted GitHub Actions cache server: cache hits and misses, uploads and storage size.'
---

Scrape Prometheus metrics to monitor cache performance.

The server exposes [Prometheus](https://prometheus.io/) metrics at `GET /metrics` in the standard text exposition format. The endpoint is always enabled and unauthenticated.

:::caution
`/metrics` has no authentication. Restrict access at the network layer (firewall, Kubernetes `NetworkPolicy`, or a reverse proxy) if the endpoint should not be publicly reachable.
:::

## Scraping

Point Prometheus at the server:

```yaml title="prometheus.yml"
scrape_configs:
  - job_name: gha-cache-server
    static_configs:
      - targets: ['cache-server:3000']
```

## Exposed metrics

| Metric                                       | Type    | Description                                                                                                                           |
| -------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `cache_requests_total{result="hit"\|"miss"}` | counter | Cache download-URL lookups by result. A restore-key prefix match counts as a `hit`.                                                   |
| `cache_uploads_total`                        | counter | Cache uploads finalized into cache entries.                                                                                           |
| `cache_storage_bytes`                        | gauge   | Total size of finalized cache payloads currently in storage.                                                                          |
| `process_*`                                  | gauge   | Default process metrics: CPU, resident and virtual memory, open file descriptors, threads, and `process_start_time_seconds` (uptime). |

Rates are derived in [PromQL](https://prometheus.io/docs/prometheus/latest/querying/basics/), e.g. requests per minute and hit ratio:

```text
# cache lookups per minute
rate(cache_requests_total[1m]) * 60

# hit ratio
sum(rate(cache_requests_total{result="hit"}[5m]))
  / sum(rate(cache_requests_total[5m]))
```

When [`CACHE_MAX_SIZE_BYTES`](/configuration#cache_max_size_bytes) is configured, you can chart how full the cache is against the budget:

```text
# fraction of the budget in use (0–1)
sum(cache_storage_bytes) / <CACHE_MAX_SIZE_BYTES>
```

:::note
`cache_storage_bytes` reflects payload sizes recorded at upload time.
:::

## Scaling

Metrics are collected per process. One process serves all requests, so the numbers are exact per replica, and multiple replicas are aggregated by Prometheus:

```text
sum(rate(cache_requests_total[5m])) by (result)
```
