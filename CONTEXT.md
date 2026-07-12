# GitHub Actions Cache Server

This context describes the cache data managed by the server throughout its lifecycle.

## Language

**Cache Entry**:
A cache item available for matching and restoration by a workflow.

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
