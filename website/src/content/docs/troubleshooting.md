---
title: Troubleshooting
description: 'Confirm your self-hosted runners use the GitHub Actions cache server, and fix the common causes when they do not: missing trailing slash, runner self-update, cache service v1, 401 Invalid token, unreachable API_BASE_URL.'
---

A misconfigured runner does not fail. It falls back to GitHub's hosted cache, or skips the cache, and the job stays green. So check that requests arrive before you trust the setup.

## Confirm the runner uses your server

Run any workflow with a cache step, then check one of these:

- **Metrics.** `cache_requests_total` on [`/metrics`](/metrics) goes up with every lookup:

  ```bash
  curl -s http://cache-server.internal:3000/metrics | grep cache_requests_total
  ```

- **Logs.** Start the server with [`DEBUG=1`](/configuration#debug). Every request is logged:

  ```text
  Request: POST /twirp/github.actions.results.api.v1.CacheService/GetCacheEntryDownloadURL
  Response: POST /twirp/github.actions.results.api.v1.CacheService/GetCacheEntryDownloadURL > 200
  ```

- **Job log.** On a hit, the `actions/cache` step logs `Cache restored from key: ...`. A restore that takes seconds for a large cache on a local network is your server. GitHub's cache from a self-hosted runner is usually much slower.

If none of these show traffic, work through the list below.

## Common causes

| Symptom | Cause | Fix |
| --- | --- | --- |
| No requests reach the server | The stock runner overwrote `ACTIONS_RESULTS_URL` | Use the [forked runner](/getting-started#forked-runner-recommended) or the [binary patch](/getting-started#binary-patch) |
| Worked, then stopped without an error | The runner self-updated and restored the stock binary | Use the forked runner, or register with `config.sh --disableupdate` |
| Cache steps warn and skip the cache | `CUSTOM_ACTIONS_RESULTS_URL` or `ACTIONS_RESULTS_URL` lacks the trailing slash | Use `http://cache-server.internal:3000/` |
| Lookups succeed, uploads or downloads time out | Runners cannot reach `API_BASE_URL` | Set [`API_BASE_URL`](/configuration#api_base_url) to an address the runners can reach |
| Every request answers `401 Invalid token` | The token issuer does not match | Set [`ACTIONS_TOKEN_ISSUER`](/configuration#actions_token_issuer), see [GHES](/guides/github-enterprise-server) |
| Direct downloads fail | Runners cannot reach the bucket, or the credentials cannot sign URLs | Open the network path, see the [storage driver](/storage-drivers) permissions |
| GHES runner never calls the server | Cache service v2 is off, the runner uses the v1 protocol | [Enable v2](/guides/github-enterprise-server#1-enable-cache-service-v2) |
| GitHub stops sending jobs to the runner | The runner is more than about 30 days behind | [Update the runner image](/getting-started#keep-the-runner-up-to-date) |
| A job has no cache at all | The workflow has no cache step and no `setup-*` with `cache:` | The server only serves caches a workflow asks for |

## Still stuck

Open an issue at [falcondev-oss/github-actions-cache-server](https://github.com/falcondev-oss/github-actions-cache-server/issues) with the server version, the drivers, and the debug log of one failing request.
