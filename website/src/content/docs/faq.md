---
title: FAQ
description: 'Answers about the self-hosted GitHub Actions cache server: local caching without workflow changes, ephemeral runners, actions/cache on-premise, BuildKit type=gha, artifacts, security, GitHub-hosted runners and alternatives.'
---

## Can I keep the GitHub Actions cache local without changing workflow files?

Yes. That is what this server is for. Run it next to your self-hosted runners, point the runners at it with the [forked runner](/getting-started#forked-runner-recommended), and every `actions/cache` step, `setup-*` cache and BuildKit `type=gha` cache uses it. Workflow YAML stays the same.

## Does it work with ephemeral runners?

Yes, and that is where it helps most. An ephemeral runner starts empty every job, so a cache on its own disk is gone after one job. The cache server keeps the cache outside the runner, so the next disposable runner restores it at local network speed. See [ephemeral runners with a local cache](/guides/ephemeral-runners-local-cache).

## Does it work with Actions Runner Controller (ARC)?

Yes. Swap the runner image in your scale set for the forked image and set one environment variable. The [ARC guide](/guides/actions-runner-controller) has complete Helm values.

## Is this the same as mounting a cache volume into the runner?

No. A `hostPath` or persistent volume only helps tools you configure to use it, so you edit workflows to set cache directories, and the cache only exists on that one node. The cache server speaks the `actions/cache` protocol, so existing cache steps use it unchanged, from any node. [Compare the options](/guides/github-actions-cache-options).

## Which actions and tools are supported?

Anything built on `@actions/cache` with the v2 cache service:

- `actions/cache`, `actions/cache/restore`, `actions/cache/save` (v4 and later)
- `actions/setup-node`, `setup-python`, `setup-go`, `setup-java`, `setup-dotnet` and other `setup-*` actions with caching enabled
- Docker BuildKit with `cache-from: type=gha` and `cache-to: type=gha`
- Third-party actions that use `@actions/cache` internally, such as `Swatinem/rust-cache`

## Does it cache artifacts too?

No. `actions/upload-artifact` and `actions/download-artifact` requests are forwarded to GitHub's results service unchanged, so they keep working but are not stored locally.

## Can GitHub-hosted runners use it?

No. GitHub-hosted runners use the stock runner, which always overwrites the cache URL. The server is for self-hosted runners.

## Do I need the forked runner?

You need a runner that keeps your `ACTIONS_RESULTS_URL`. Use the [forked runner image](/getting-started#forked-runner-recommended), or patch the stock binary yourself with the [binary patch](/getting-started#binary-patch). The fork also skips self-update so a runner update cannot silently undo the patch.

## Is it secure?

The server verifies every runner token against GitHub's signing keys, scopes caches per repository and branch like GitHub does, and signs each upload URL. Keep the server on your CI network. `/metrics` has no authentication. As with any shared cache, only let mutually trusted workflows write to it: a malicious pull request on a self-hosted runner can poison caches of its own scope.

## Which storage should I use?

On one machine, the default [filesystem driver](/storage-drivers/file-system) with SQLite on local NVMe is the fastest and simplest setup. For several replicas or several runner nodes, use [S3 compatible storage](/storage-drivers/s3) (RustFS, MinIO, R2, AWS) with [PostgreSQL](/database-drivers/postgres).

## How big does the cache get?

As big as you allow. Entries unused for 90 days are deleted by default ([`CACHE_CLEANUP_OLDER_THAN_DAYS`](/configuration#cache_cleanup_older_than_days)). Set [`CACHE_MAX_SIZE_BYTES`](/configuration#cache_max_size_bytes) for a hard budget with least-recently-used eviction. On the filesystem driver the server evicts at 90% disk usage by default. There is no 10 GB per-repository limit.

## How fast is it?

On one NVMe host: 7.9 GiB/s first download, 2.3 GiB/s parallel upload, 34,000 lookups per second, 3 MiB idle memory. See [benchmarks](/benchmarks) for the method and how to reproduce it.

## Does it work with GitHub Enterprise Server?

Yes, on a best-effort basis, when cache service v2 is enabled. See [GitHub Enterprise Server](/guides/github-enterprise-server).

## Is it free?

Yes. MIT licensed, no paid tier. Source at [falcondev-oss/github-actions-cache-server](https://github.com/falcondev-oss/github-actions-cache-server).
