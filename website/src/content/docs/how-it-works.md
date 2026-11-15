---
title: How it works
description: "How the self-hosted GitHub Actions cache server stands in for GitHub's cache backend: the cache API v2 it implements, why the runner needs a patch, how uploads, merges and downloads flow, and how caches are scoped."
---

The server implements the same cache API that GitHub's hosted cache service exposes to runners. `@actions/cache` cannot tell the two apart, so every tool built on it works without changes.

## Request flow

```text
 workflow step (actions/cache, setup-node, BuildKit type=gha)
        │  Twirp: GetCacheEntryDownloadURL / CreateCacheEntry / FinalizeCacheEntryUpload
        ▼
 runner  ── ACTIONS_RESULTS_URL ──▶  cache server  ──▶  storage driver (filesystem, S3, GCS, Azure)
        │                                  │
        │  PUT /upload/{id} (blocks)       └──▶  database driver (SQLite, Postgres, MySQL)
        │  GET /download/{id} or a signed storage URL
        ▼
 everything else (artifacts, logs) is forwarded to DEFAULT_ACTIONS_RESULTS_URL
```

1. **Lookup.** The runner asks for a key and a list of restore keys. The server answers with a download URL for the best match in the job's scope, or a miss.
2. **Upload.** On a miss, the step reserves an entry and uploads the archive in blocks to the signed upload URL the server hands out. On object storage the blocks go straight to the bucket through presigned URLs.
3. **Finalize.** The runner commits the upload. The entry becomes visible to the next lookup.
4. **Merge.** Blocks are merged into one object on the first full download, or right after upload with [`EAGER_MERGE`](/configuration#eager_merge).
5. **Download.** The server streams the object, or hands out a signed storage URL with [`ENABLE_DIRECT_DOWNLOADS`](/configuration#enable_direct_downloads). It serves byte ranges from `Range` or, as the Azure SDK in BuildKit's `type=gha` cache sends them, `x-ms-range`. Before the merge, a range is read from the blocks it covers.

Requests the server does not handle, such as artifact uploads, are forwarded to GitHub's results service, so they keep working.

## Cache scoping

Every request carries the runner's job token. The server verifies its signature against the issuer's keys, then reads the repository and the cache scopes (the branch refs) the token grants. A job saves to its own branch and restores from its branch and the branches GitHub lets it read, the same rules GitHub's hosted cache applies. A job in one repository never sees another repository's cache. Upload URLs carry a per-upload capability, so knowing an upload id is not enough to write into it.

## Why the runner needs a patch

The runner sets `ACTIONS_RESULTS_URL` from the job message on every job, so a value you set yourself is overwritten:

```csharp title="Excerpt from the runner source"
var systemConnection = ExecutionContext.Global.Endpoints.Single(x => string.Equals(x.Name, WellKnownServiceEndpointNames.SystemVssConnection, StringComparison.OrdinalIgnoreCase));
Environment["ACTIONS_RUNTIME_URL"] = systemConnection.Url.AbsoluteUri;
Environment["ACTIONS_RUNTIME_TOKEN"] = systemConnection.Authorization.Parameters[EndpointAuthorizationParameters.AccessToken];
if (systemConnection.Data.TryGetValue("CacheServerUrl", out var cacheUrl) && !string.IsNullOrEmpty(cacheUrl))
{
    Environment["ACTIONS_CACHE_URL"] = cacheUrl;
}
if (systemConnection.Data.TryGetValue("PipelinesServiceUrl", out var pipelinesServiceUrl) && !string.IsNullOrEmpty(pipelinesServiceUrl))
{
    Environment["ACTIONS_RUNTIME_URL"] = pipelinesServiceUrl;
}
if (systemConnection.Data.TryGetValue("GenerateIdTokenUrl", out var generateIdTokenUrl) && !string.IsNullOrEmpty(generateIdTokenUrl))
{
    Environment["ACTIONS_ID_TOKEN_REQUEST_URL"] = generateIdTokenUrl;
    Environment["ACTIONS_ID_TOKEN_REQUEST_TOKEN"] = systemConnection.Authorization.Parameters[EndpointAuthorizationParameters.AccessToken];
}
if (systemConnection.Data.TryGetValue("ResultsServiceUrl", out var resultsUrl) && !string.IsNullOrEmpty(resultsUrl))
{
    Environment["ACTIONS_RESULTS_URL"] = resultsUrl;
}

if (ExecutionContext.Global.Variables.GetBoolean("actions_uses_cache_service_v2") ?? false)
{
    Environment["ACTIONS_CACHE_SERVICE_V2"] = bool.TrueString;
}
```

The [binary patch](/getting-started#binary-patch) replaces the string `ACTIONS_RESULTS_URL` with `ACTIONS_RESULTS_ORL`, so the runner writes a dummy variable and yours survives. The [forked runner](https://github.com/falcondev-oss/github-actions-runner) does the same in source and reads your URL from `CUSTOM_ACTIONS_RESULTS_URL`.

## Background jobs

Each job runs once at startup, then once per period. [`DISABLE_CLEANUP_JOBS`](/configuration#disable_cleanup_jobs) turns them all off.

| Period | Job |
| --- | --- |
| 5 minutes | Delete uploads without activity for over a minute |
| 10 minutes | Delete parts of merged entries, and storage locations without an entry |
| 1 hour | Reset stalled merges and expired leases |
| 24 hours | Delete entries older than [`CACHE_CLEANUP_OLDER_THAN_DAYS`](/configuration#cache_cleanup_older_than_days), and orphaned storage |

Capacity-based eviction runs after every finalized upload when [`CACHE_MAX_SIZE_BYTES`](/configuration#cache_max_size_bytes) or [`CACHE_FILESYSTEM_MAX_USAGE_PERCENT`](/configuration#cache_filesystem_max_usage_percent) is exceeded, least recently used first.
