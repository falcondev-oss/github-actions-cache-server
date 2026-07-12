# GitHub Actions Cache Server

This context describes the cache data managed by the server throughout its lifecycle.

## Language

**Cache Entry**:
A cache item available for matching and restoration by a workflow.

**Storage Budget**:
The maximum amount of cache-server-managed, finalized cache payloads that may occupy storage before capacity-based eviction reclaims space. An explicit byte-based maximum may define it for any storage backend; otherwise it is a configurable percentage of the filesystem capacity, defaulting to 90%. Object-storage backends have no budget unless an explicit maximum is configured.
_Avoid_: Storage limit, disk limit

**Filesystem Capacity**:
The total capacity and occupancy of the mounted volume that contains filesystem storage, including data outside the cache directory.
_Avoid_: Cache directory size

**Capacity-based Eviction**:
Removal of finalized cache entries after an upload completes to bring cache storage within its Storage Budget, ordered by Cache Recency. Each eviction pass reclaims space until use is 90% of the budget.
_Avoid_: Cache rotation, cleanup at X%

**Storage Reconciliation**:
A resumable, one-time startup measurement that records byte usage for stored cache data predating size tracking.
_Avoid_: Size backfill, bucket scan

**Cache Access**:
Authorization to retrieve a cache payload, either by starting a proxied download or issuing a direct-download URL. It determines a cache payload's recency even when completion cannot be observed.
_Avoid_: Successful download

**Cache Recency**:
The ordering value for Capacity-based Eviction: a cache payload's most recent Cache Access, falling back to the time its cache entry was last saved or replaced.
_Avoid_: Cache age

**Upload**:
Cache data that is being received but has not yet become a Cache Entry.

**Storage Location**:
The stored data belonging to a Cache Entry.

**Part**:
A segment of cache data stored before its merged representation has been created.

**Merge**:
The creation of a cache's consolidated stored representation from its Parts.

**Merge Lease**:
A time-bound, fenced claim granting one worker authority to complete a Merge.

**Storage Reader Lease**:
A time-bound claim that a download is actively reading data from a Storage Location.

**Part Reader Lease**:
A Storage Reader Lease held by a download that is reading a Storage Location's Parts.

**Orphaned Storage**:
Stored cache data that, after a safety grace period, belongs to neither an Upload nor a Storage Location.
_Avoid_: Orphan blob, orphaned storage location

**Dangling Cache Entry**:
A Cache Entry whose Storage Location references storage that no longer physically exists, caused by external mutation of storage the server owns (bucket wipe, external lifecycle expiry, out-of-sync database restore). The mirror of Orphaned Storage.
_Avoid_: stale entry, missing cache

**Cache Hit**:
A download-URL request that matched an existing Cache Entry — by exact key or by a restore-key prefix — and passed dangling-entry validation.

**Cache Miss**:
A download-URL request that found no usable Cache Entry. Includes the case where the only match was a Dangling Cache Entry that was purged with no fallback match.

**Results Passthrough**:
The transparent forwarding of a Results request that the cache server does not handle, and its response, without interpreting either.

**Default Results Origin**:
The upstream GitHub Actions Results service that receives Results Passthrough requests, configured by `DEFAULT_ACTIONS_RESULTS_URL`.
_Avoid_: Artifact server, fallback server
