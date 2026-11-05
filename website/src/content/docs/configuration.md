---
title: Configuration
description: 'Every environment variable of the self-hosted GitHub Actions cache server: API_BASE_URL, storage and database drivers, direct downloads, eviction, token validation, cleanup jobs and the management API.'
---

Every variable is also a command-line flag of the same name in kebab case, e.g. `API_BASE_URL` is `--api-base-url`. A flag overrides its variable. Run the binary with `--help` to list them all. An empty variable counts as unset.

The server refuses to start on invalid configuration. A missing required value or a value that does not parse exits with code `2`, a conflicting combination of variables with code `1`.

| Variable | Default |
| --- | --- |
| [`API_BASE_URL`](#api_base_url) | required |
| [`PORT`](#port) | `3000` |
| [`HOST`](#host) | all interfaces |
| [`DEFAULT_ACTIONS_RESULTS_URL`](#default_actions_results_url) | `https://results-receiver.actions.githubusercontent.com` |
| [`DEBUG`](#debug) | unset |
| [`STORAGE_DRIVER`](#storage_driver) | `filesystem` |
| [`DB_DRIVER`](#db_driver) | `sqlite` |
| [`ENABLE_DIRECT_DOWNLOADS`](#enable_direct_downloads) | `false` |
| [`DIRECT_DOWNLOAD_URL_TTL_SECONDS`](#direct_download_url_ttl_seconds) | `600` |
| [`EAGER_MERGE`](#eager_merge) | `false` |
| [`MAX_CONCURRENT_MERGES`](#max_concurrent_merges) | `16` |
| [`DOWNLOAD_IDLE_TIMEOUT_MS`](#download_idle_timeout_ms) | `300000` |
| [`CACHE_CLEANUP_OLDER_THAN_DAYS`](#cache_cleanup_older_than_days) | `90` |
| [`CACHE_MAX_SIZE_BYTES`](#cache_max_size_bytes) | unset |
| [`CACHE_FILESYSTEM_MAX_USAGE_PERCENT`](#cache_filesystem_max_usage_percent) | `90` |
| [`ORPHANED_STORAGE_GRACE_PERIOD_HOURS`](#orphaned_storage_grace_period_hours) | `24` |
| [`DISABLE_CLEANUP_JOBS`](#disable_cleanup_jobs) | `false` |
| [`ACTIONS_TOKEN_ISSUER`](#actions_token_issuer) | `https://token.actions.githubusercontent.com` |
| [`ACTIONS_TOKEN_JWKS_URL`](#actions_token_jwks_url) | discovered from the issuer |
| [`ACTIONS_TOKEN_AUDIENCE`](#actions_token_audience) | unset |
| [`SKIP_TOKEN_VALIDATION`](#skip_token_validation) | `false` |
| [`UNSAFE_ALLOW_DIRECT_DOWNLOADS_WITHOUT_TOKEN_VALIDATION`](#unsafe_allow_direct_downloads_without_token_validation) | `false` |
| [`MANAGEMENT_API_KEY`](#management_api_key) | unset |

## Server

### `API_BASE_URL`

- Required
- Example: `http://cache-server.internal:3000`

The URL runners use to reach this server. Upload and download URLs handed to runners start with it, so every runner must be able to reach it.

### `PORT`

- Default: `3000`

The port the server should listen on.

### `HOST`

- Default: all interfaces

The interface the server should listen on.

### `DEFAULT_ACTIONS_RESULTS_URL`

- Default: `https://results-receiver.actions.githubusercontent.com`

The upstream GitHub Actions Results service that requests the cache server does not handle (e.g. artifact uploads/downloads) are transparently forwarded to. On **GitHub Enterprise Server** this must point at your instance's Results host (see [GitHub Enterprise Server](/guides/github-enterprise-server)).

### `DEBUG`

- Optional

Any value enables debug logging.

## Storage and database

### `STORAGE_DRIVER`

- Default: `filesystem`

The storage driver to use for storing cache data. For more information, see [storage drivers](/storage-drivers).

### `DB_DRIVER`

- Default: `sqlite`

The database driver to use for storing cache metadata. For more information, see [database drivers](/database-drivers).

## Downloads and merges

### `ENABLE_DIRECT_DOWNLOADS`

- Default: `false`

If set to `true`, will send a signed URL to the runner. The runner can then download the cache directly from the storage provider. This is useful if you have a large cache and don't want to proxy the download through the cache server.

:::caution
The actions runner needs to be able to reach the storage provider directly to use direct downloads.
:::

A signed URL is a storage credential, so the server refuses to start with both `ENABLE_DIRECT_DOWNLOADS=true` and [`SKIP_TOKEN_VALIDATION=true`](#skip_token_validation), unless [`UNSAFE_ALLOW_DIRECT_DOWNLOADS_WITHOUT_TOKEN_VALIDATION`](#unsafe_allow_direct_downloads_without_token_validation) is set. The filesystem storage driver has no direct downloads.

### `DIRECT_DOWNLOAD_URL_TTL_SECONDS`

- Default: `600`
- Range: `1` to `3600`
- Helm: `config.directDownloadUrlTtlSeconds`

How long a signed direct-download URL stays valid. A shorter lifetime limits the replay of a leaked URL. Clients that fetch the URL some time after receiving it, such as BuildKit, need a longer one.

### `EAGER_MERGE`

- Default: `false`

Cache data arrives in parts. By default the server merges them into one object on the first download, so with `ENABLE_DIRECT_DOWNLOADS` the first restore of every entry is still proxied through the server. With `EAGER_MERGE=true` the merge starts right after the upload completes, and the first restore can be a direct download.

On S3, GCS and Azure Blob Storage the server streams the parts through itself into the merged object, so every upload is read back once. On the filesystem driver the merge is a kernel copy (`copy_file_range`). Eager and lazy merges share the [`MAX_CONCURRENT_MERGES`](#max_concurrent_merges) limit.

:::caution
Every entry occupies twice its size until the parts cleanup job removes the parts, including entries that are never restored.
:::

### `MAX_CONCURRENT_MERGES`

- Default: `16`

How many merges one process runs at once, eager or lazy. Past that limit, restores stream the parts and a later download does the merge.

### `DOWNLOAD_IDLE_TIMEOUT_MS`

- Default: `300000`

Closes a connection whose client has not read a response for this long. `0` disables it.

## Eviction and cleanup

### `CACHE_CLEANUP_OLDER_THAN_DAYS`

- Default: `90`

The number of days to keep stale cache data and metadata before deleting it. Set to `0` to disable cache cleanup. A negative value fails startup.

### `CACHE_MAX_SIZE_BYTES`

- Optional

Hard cap, in bytes, on the total size of finalized cache payloads. When set, the server runs **capacity-based eviction** after each completed upload: if the total exceeds this budget, the least-recently-used cache entries are deleted until usage is back down to 90% of the budget. Recency is the last time an entry was downloaded, falling back to when it was last saved. Entries with an in-progress download are never evicted.

Applies to any storage driver. Leave unset for unlimited object storage, or use `CACHE_FILESYSTEM_MAX_USAGE_PERCENT` below to cap by disk usage instead.

:::tip
Eviction runs _after_ an upload finalizes, so the total may briefly exceed the budget under concurrent uploads. Leave headroom for in-flight uploads.
:::

### `CACHE_FILESYSTEM_MAX_USAGE_PERCENT`

- Default: `90`
- Only applies to the `filesystem` storage driver when `CACHE_MAX_SIZE_BYTES` is **not** set.

Maximum percentage of the storage volume's total capacity (including data outside the cache directory) that may be used before capacity-based eviction starts reclaiming space. Ignored when `CACHE_MAX_SIZE_BYTES` is set.

### `ORPHANED_STORAGE_GRACE_PERIOD_HOURS`

- Default: `24`

How long a storage folder that no database record references must stay untouched before cleanup deletes it. At least `1`.

### `DISABLE_CLEANUP_JOBS`

- Default: `false`

Disables all cleanup jobs. Each job runs once at startup, then once per period:

| Period     | Job                                                                             |
| ---------- | ------------------------------------------------------------------------------- |
| 5 minutes  | Delete uploads without activity for over a minute                               |
| 10 minutes | Delete parts of merged entries, and storage locations without an entry          |
| 1 hour     | Reset stalled merges and expired leases                                         |
| 24 hours   | Delete entries older than `CACHE_CLEANUP_OLDER_THAN_DAYS`, and orphaned storage |

## Token validation

### `ACTIONS_TOKEN_ISSUER`

- Default: `https://token.actions.githubusercontent.com`

The OIDC issuer whose signature the cache server verifies on runner tokens. It must match the `iss` claim of a runner's OIDC token exactly. The signing keys are looked up from the issuer's OIDC discovery document (`{issuer}/.well-known/openid-configuration`), so the JWKS location is picked up automatically.

Change this if your runner tokens are not issued by `https://token.actions.githubusercontent.com`:

- **GitHub Enterprise Server**, where tokens are issued by your own instance (see [GitHub Enterprise Server](/guides/github-enterprise-server)).
- **GitHub Enterprise Cloud with a [customized issuer](https://docs.github.com/en/enterprise-cloud@latest/actions/reference/security/oidc#customizing-the-issuer-value-for-an-enterprise)**, where the issuer becomes `https://token.actions.githubusercontent.com/<enterpriseSlug>`. Nothing else is needed: the JWKS stays at the default host, and discovery finds it there.

### `ACTIONS_TOKEN_JWKS_URL`

- Optional
- Default: discovered from [`ACTIONS_TOKEN_ISSUER`](#actions_token_issuer)

Explicit JWKS endpoint, skipping OIDC discovery. You should not need this: the URL is normally discovered from the issuer, and if discovery is unavailable the server falls back to `{issuer}/.well-known/jwks`. Set it only if your deployment serves its keys somewhere neither of those finds. A warning naming the fallback URL is logged when discovery fails.

### `ACTIONS_TOKEN_AUDIENCE`

- Optional
- Example: `https://github.com/my-org`

Comma-separated list of accepted `aud` claims. When set, a runner token must carry one of them. Unset skips the audience check. A value that lists no audience (e.g. `,`) fails startup.

### `SKIP_TOKEN_VALIDATION`

- Default: `false`

Skip verification of the GitHub token used for computing the cache scope. This is useful for testing and development purposes, but should not be used in production. Cannot be combined with [`ENABLE_DIRECT_DOWNLOADS`](#enable_direct_downloads) unless [`UNSAFE_ALLOW_DIRECT_DOWNLOADS_WITHOUT_TOKEN_VALIDATION`](#unsafe_allow_direct_downloads_without_token_validation) is set.

### `UNSAFE_ALLOW_DIRECT_DOWNLOADS_WITHOUT_TOKEN_VALIDATION`

- Default: `false`

Allows `ENABLE_DIRECT_DOWNLOADS=true` together with `SKIP_TOKEN_VALIDATION=true`. Anyone who can reach the server then gets signed storage URLs for any repository's cache. For local testing only.

## Management API

### `MANAGEMENT_API_KEY`

Set this to a random string to enable the management API. Unset or empty disables it. Docs can be found at `https://<your-cache-server-url>/management-api/_docs`.

`DELETE /management-api/storage-locations/{id}` answers `409` while the storage location is being downloaded.

Driver-specific variables are on the [storage driver](/storage-drivers) and [database driver](/database-drivers) pages.
