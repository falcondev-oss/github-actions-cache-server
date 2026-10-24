//! Cache data lifecycle: uploads, matching, downloads, merges and capacity-based eviction.

mod adapter;
mod filesystem;
mod leases;
mod lifecycle;
mod object;

use std::collections::HashMap;
use std::fmt::Display;
use std::io;
use std::sync::Arc;
use std::time::Duration;

use axum::body::Bytes;
use futures_util::future::BoxFuture;
use futures_util::{FutureExt as _, StreamExt as _, TryStreamExt as _, stream};
use sea_query::{
    Alias, CaseStatement, Cond, Expr, Func, JoinType, LockType, Order, Query, SelectStatement,
};
use serde::Serialize;
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;
use tokio_util::task::{AbortOnDropHandle, TaskTracker};
use utoipa::ToSchema;

use self::adapter::ReadError;
pub(crate) use self::adapter::{Adapter, ByteStream, DownloadStream, RangeRequest, UploadKind};
use self::leases::{
    DIRECT_DOWNLOAD_LEASE_DURATION, LEASE_DURATION, LEASE_RENEWAL, acquire_merge_lease,
    create_reader_lease, deadline, release_merge_lease, release_reader_lease, renew_merge_lease,
    renew_reader_lease,
};
pub(crate) use self::lifecycle::{
    LocationDeletion, claim_parts_deletion_if_unread, delete_storage_location_if_unread,
    no_active_reader_lease,
};
use crate::config::Config;
pub(crate) use crate::db::EntryIdentity;
use crate::db::{
    CacheEntries, CacheEntry, Db, FolderRow, IdRow, MergeLeases, ReaderLeaseScope, StorageLocation,
    StorageLocations, TotalRow, Upload, UploadFolder, Uploads, insert_entry, insert_location,
    is_unique_violation, now_ms, retry_on_lock_conflict, select_entries, select_locations,
};
use crate::error::{Failure, Result};

/// Bounds the self-heal retry when matching keeps surfacing Dangling Cache Entries for the same
/// prefix; caps a pathological scan (ADR-0005).
const MAX_DANGLING_PURGE_ATTEMPTS: u32 = 10;

/// What a restore asks for: a primary key plus fallbacks, tried across scopes in order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CacheQuery {
    pub(crate) primary_key: String,
    pub(crate) restore_keys: Vec<String>,
    pub(crate) version: String,
    pub(crate) scopes: Vec<String>,
    pub(crate) repo_id: String,
}

/// How a cache entry matched a [`CacheQuery`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum MatchType {
    ExactPrimary,
    PrefixedPrimary,
    ExactRestore,
    PrefixedRestore,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub(crate) struct CacheEntryMatch {
    #[serde(rename = "match")]
    pub(crate) entry: CacheEntry,
    #[serde(rename = "type")]
    pub(crate) match_type: MatchType,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DownloadUrlMatch {
    pub(crate) download_url: String,
    pub(crate) entry: CacheEntry,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CreatedUpload {
    Created { id: i64 },
    AlreadyExists,
}

#[derive(Debug, thiserror::Error)]
pub(crate) enum DownloadError {
    #[error("range not satisfiable")]
    RangeNotSatisfiable { size: Option<u64> },
    #[error(transparent)]
    Failed(#[from] Failure),
}

#[derive(Debug)]
pub(crate) struct Storage {
    pub(crate) db: Db,
    pub(crate) adapter: Arc<Adapter>,
    config: Arc<Config>,
    merges: TaskTracker,
}

/// Where a folder keeps its Parts.
pub(crate) fn parts_folder(folder: &str) -> String {
    format!("{folder}/parts")
}

fn part_object(folder: &str, index: impl Display) -> String {
    format!("{folder}/parts/{index}")
}

fn merged_object(folder: &str) -> String {
    format!("{folder}/merged")
}

/// The one object holding all of a location's bytes, and the reader lease that protects it: the
/// merged object, or the only Part of a single-Part location, which needs no Merge.
fn whole_object(location: &StorageLocation) -> Option<(String, ReaderLeaseScope)> {
    if location.merged_at.is_some() {
        return Some((
            merged_object(&location.folder_name),
            ReaderLeaseScope::Storage,
        ));
    }
    (location.part_count == 1 && location.parts_deleted_at.is_none()).then(|| {
        (
            part_object(&location.folder_name, 0),
            ReaderLeaseScope::Parts,
        )
    })
}

fn entry_identity(identity: &EntryIdentity) -> Cond {
    Cond::all()
        .add(Expr::col((CacheEntries::Table, CacheEntries::Key)).eq(identity.key.as_str()))
        .add(Expr::col((CacheEntries::Table, CacheEntries::Version)).eq(identity.version.as_str()))
        .add(Expr::col((CacheEntries::Table, CacheEntries::Scope)).eq(identity.scope.as_str()))
        .add(Expr::col((CacheEntries::Table, CacheEntries::RepoId)).eq(identity.repo_id.as_str()))
}

/// Concatenates a location's Parts as they are read.
fn stream_parts(adapter: Arc<Adapter>, location: &StorageLocation) -> ByteStream {
    if location.parts_deleted_at.is_some() {
        return stream::once(async {
            Err(io::Error::other(
                "no parts to feed for location with deleted parts",
            ))
        })
        .boxed();
    }
    let folder = location.folder_name.clone();
    stream::iter(0..location.part_count)
        .then(move |index| {
            let adapter = Arc::clone(&adapter);
            let name = part_object(&folder, index);
            async move {
                adapter
                    .download_stream(&name, None)
                    .await
                    .map(|download| download.stream)
                    .map_err(io::Error::other)
            }
        })
        .try_flatten()
        .boxed()
}

/// Releases a Storage Reader Lease and stops its renewal once the protected stream is dropped.
struct LeaseGuard {
    db: Db,
    lease_id: String,
    /// Completes once the lease is lost.
    renewal: AbortOnDropHandle<()>,
}

impl Drop for LeaseGuard {
    fn drop(&mut self) {
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            return;
        };
        let db = self.db.clone();
        let lease_id = std::mem::take(&mut self.lease_id);
        // an unreleased lease only delays cleanup until it expires
        drop(runtime.spawn(async move {
            if let Err(error) = release_reader_lease(&db, &lease_id).await {
                tracing::warn!(%error, lease_id, "failed to release Storage Reader Lease");
            }
        }));
    }
}

/// Sends a chunk unless the receiving side is gone; returns whether it is still listening.
async fn feed(sender: Option<&mpsc::Sender<io::Result<Bytes>>>, chunk: Bytes) -> bool {
    match sender {
        Some(sender) => sender.send(Ok(chunk)).await.is_ok(),
        None => false,
    }
}

/// Tees the Parts into the client response and the merge upload, paced by the slower reader.
/// A side that goes away stops being fed without disturbing the other.
async fn pump_parts(
    mut parts: ByteStream,
    response: mpsc::Sender<io::Result<Bytes>>,
    merger: mpsc::Sender<io::Result<Bytes>>,
) {
    let mut response = Some(response);
    let mut merger = Some(merger);
    while response.is_some() || merger.is_some() {
        match parts.next().await {
            None => break,
            Some(Ok(chunk)) => {
                let (response_open, merger_open) = tokio::join!(
                    feed(response.as_ref(), chunk.clone()),
                    feed(merger.as_ref(), chunk)
                );
                if !response_open {
                    response = None;
                }
                if !merger_open {
                    merger = None;
                }
            }
            Some(Err(error)) => {
                tracing::warn!(%error, "failed to read parts");
                for sender in [response, merger].into_iter().flatten() {
                    if sender
                        .send(Err(io::Error::other(error.to_string())))
                        .await
                        .is_err()
                    {
                        tracing::debug!("parts reader went away before the failure");
                    }
                }
                return;
            }
        }
    }
}

/// Renews a lease every [`LEASE_RENEWAL`] until `renew` reports it lost or fails; the returned
/// handle completes then, and stops the renewal when dropped.
fn keep_renewing<F, Fut>(mut renew: F) -> AbortOnDropHandle<()>
where
    F: FnMut() -> Fut + Send + 'static,
    Fut: Future<Output = Result<bool>> + Send,
{
    AbortOnDropHandle::new(tokio::spawn(async move {
        let mut ticks = tokio::time::interval(LEASE_RENEWAL);
        ticks.tick().await;
        loop {
            ticks.tick().await;
            match renew().await {
                Ok(true) => {}
                Ok(false) => {
                    tracing::warn!("lease was lost");
                    return;
                }
                Err(error) => {
                    tracing::warn!(%error, "failed to renew lease");
                    return;
                }
            }
        }
    }))
}

impl Storage {
    pub(crate) async fn new(db: Db, adapter: Adapter, config: Arc<Config>) -> Result<Self> {
        let storage = Self {
            db,
            adapter: Arc::new(adapter),
            config,
            merges: TaskTracker::new(),
        };
        storage.reconcile_storage_location_sizes().await?;
        Ok(storage)
    }

    /// Waits for background merges, e.g. before shutting down.
    pub(crate) async fn wait_for_ongoing_merges(&self) {
        self.merges.close();
        self.merges.wait().await;
    }

    /// Discards an upload that cannot become a cache entry; returns the failure to report.
    async fn abandon_upload(&self, upload: &Upload, reason: String) -> Failure {
        let deleted = self
            .db
            .execute(
                &self.db.pool,
                Query::delete()
                    .from_table(Uploads::Table)
                    .and_where(Expr::col(Uploads::Id).eq(upload.id)),
            )
            .await;
        if let Err(error) = deleted {
            return Failure::msg(format!(
                "{reason} (and deleting the upload failed: {error})"
            ));
        }
        match self.adapter.delete_folder(&upload.folder_name).await {
            Ok(_) => Failure::msg(reason),
            Err(error) => Failure::msg(format!("{reason} (and cleaning up failed: {error})")),
        }
    }

    /// Wraps a download in a Storage Reader Lease that is renewed while it is read and released
    /// when it ends or is dropped.
    fn protect(&self, stream: ByteStream, lease_id: String) -> ByteStream {
        let renewal = {
            let (db, lease_id) = (self.db.clone(), lease_id.clone());
            keep_renewing(move || {
                let (db, lease_id) = (db.clone(), lease_id.clone());
                async move { renew_reader_lease(&db, &lease_id).await }
            })
        };
        let guard = LeaseGuard {
            db: self.db.clone(),
            lease_id,
            renewal,
        };
        stream::unfold(Some((stream, guard)), |state| async move {
            let (mut inner, mut lease_guard) = state?;
            tokio::select! {
                biased;
                _ = &mut lease_guard.renewal => {
                    Some((Err(io::Error::other("Storage Reader Lease was lost")), None))
                }
                item = inner.next() => item.map(|item| (item, Some((inner, lease_guard)))),
            }
        })
        .boxed()
    }

    async fn ensure_parts_exist(&self, location: &StorageLocation) -> Result<(), ReadError> {
        let folder = parts_folder(&location.folder_name);
        let parts = self.adapter.list_folder(&folder).await?;
        if i64::try_from(parts.len()).unwrap_or(i64::MAX) < location.part_count {
            return Err(ReadError::NotFound(folder));
        }
        Ok(())
    }

    async fn download_location(
        &self,
        location: &StorageLocation,
        range: Option<RangeRequest>,
    ) -> Result<DownloadStream, ReadError> {
        if let Some((object, _)) = whole_object(location) {
            return self.adapter.download_stream(&object, range).await;
        }
        self.ensure_parts_exist(location).await?;
        // No range: an unmerged entry is concatenated from its parts as it is read, so there is
        // nothing to seek into. Served whole under a 200, which Range allows.
        Ok(DownloadStream {
            stream: stream_parts(Arc::clone(&self.adapter), location),
            size: None,
            range: None,
        })
    }

    /// True iff the entry's storage physically exists. A merged entry is confirmed by its merged
    /// object; an unmerged entry by its first Part. Parts deleted without a completed merge means
    /// the data is gone. See ADR-0005.
    async fn storage_has_data(&self, location: &StorageLocation) -> Result<bool> {
        if location.merged_at.is_some() {
            return self
                .adapter
                .object_exists(&merged_object(&location.folder_name))
                .await;
        }
        if location.parts_deleted_at.is_some() || location.part_count == 0 {
            return Ok(false);
        }
        // A single-part HEAD, not a full LIST: external drift wipes the whole folder and the
        // server never produces partial Part loss, so Part 0's absence is a sufficient proxy.
        self.adapter
            .object_exists(&part_object(&location.folder_name, 0))
            .await
    }

    async fn purge_dangling_cache_entry(&self, entry_id: &str, location_id: &str) -> Result<()> {
        let mut tx = self.db.pool.begin().await?;
        self.db
            .execute(
                &mut *tx,
                Query::delete()
                    .from_table(CacheEntries::Table)
                    .and_where(Expr::col(CacheEntries::Id).eq(entry_id)),
            )
            .await?;
        // Reap the now-childless Storage Location too: an Orphaned Storage sweep scans physical
        // storage and can never see a row whose data is already gone. Respects reader leases.
        delete_storage_location_if_unread(&self.db, &mut tx, location_id).await?;
        tx.commit().await?;
        Ok(())
    }

    /// Backfills sizes of rows predating size tracking: one full listing at startup, then a
    /// no-op once every row has a size.
    async fn reconcile_storage_location_sizes(&self) -> Result<()> {
        let missing: Vec<FolderRow> = self
            .db
            .all(
                &self.db.pool,
                Query::select()
                    .columns([StorageLocations::Id, StorageLocations::FolderName])
                    .from(StorageLocations::Table)
                    .and_where(Expr::col(StorageLocations::SizeBytes).is_null()),
            )
            .await?;
        if missing.is_empty() {
            return Ok(());
        }
        let sizes: HashMap<String, u64> = self
            .adapter
            .list_storage_folders()
            .await?
            .into_iter()
            .map(|folder| (folder.folder_name, folder.bytes))
            .collect();
        for location in missing {
            let size = sizes.get(&location.folder_name).copied().unwrap_or(0);
            self.db
                .execute(
                    &self.db.pool,
                    Query::update()
                        .table(StorageLocations::Table)
                        .value(
                            StorageLocations::SizeBytes,
                            i64::try_from(size).unwrap_or(i64::MAX),
                        )
                        .and_where(Expr::col(StorageLocations::Id).eq(location.id))
                        .and_where(Expr::col(StorageLocations::SizeBytes).is_null()),
                )
                .await?;
        }
        Ok(())
    }

    /// Runs a Merge under a Merge Lease in the background. `write` produces `{folder}/merged`; a
    /// lease-fenced transaction then marks the Merge complete. Returns false when another worker
    /// holds the lease. Writing straight to the final object is safe (ADR-0004). Failures are
    /// logged and the merge state rolled back.
    async fn start_merge(
        &self,
        location: &StorageLocation,
        write: BoxFuture<'static, Result<()>>,
    ) -> Result<bool> {
        let Some(token) = claim_merge(&self.db, &location.id).await? else {
            return Ok(false);
        };
        drop(self.merges.spawn(run_merge(
            self.db.clone(),
            location.id.clone(),
            token,
            write,
        )));
        Ok(true)
    }

    /// Like [`Self::start_merge`], but claims the Merge Lease in the background too, for callers
    /// that don't wait on the Merge.
    fn start_merge_detached(
        &self,
        location: &StorageLocation,
        write: BoxFuture<'static, Result<()>>,
    ) {
        let (db, id) = (self.db.clone(), location.id.clone());
        drop(self.merges.spawn(async move {
            match claim_merge(&db, &id).await {
                Ok(Some(token)) => run_merge(db, id, token, write).await,
                Ok(None) => {}
                Err(error) => {
                    tracing::warn!(%error, storage_location_id = id, "failed to start merge");
                }
            }
        }));
    }

    /// Writes `{folder}/merged` from a location's Parts.
    fn merge_parts(&self, location: &StorageLocation) -> BoxFuture<'static, Result<()>> {
        let adapter = Arc::clone(&self.adapter);
        let merged = merged_object(&location.folder_name);
        let part_stream = stream_parts(Arc::clone(&adapter), location);
        let kind = UploadKind::Merged {
            length: location
                .size_bytes
                .and_then(|size| u64::try_from(size).ok()),
        };
        let parts: Vec<String> = (0..location.part_count)
            .map(|index| part_object(&location.folder_name, index))
            .collect();
        async move {
            match adapter.as_ref() {
                Adapter::Filesystem(filesystem) => filesystem.concat(&parts, &merged).await,
                Adapter::Object(_) => adapter.upload_stream(&merged, part_stream, kind).await,
            }
        }
        .boxed()
    }

    /// Stores one Part of an upload. False when the upload does not exist, or was deleted while
    /// the Part was streaming (the written Part is then Orphaned Storage, ADR-0001).
    pub(crate) async fn upload_part(
        &self,
        upload_id: i64,
        part_index: u32,
        stream: ByteStream,
        length: Option<u64>,
    ) -> Result<bool> {
        let upload: Option<UploadFolder> = self
            .db
            .optional(
                &self.db.reads,
                Query::select()
                    .columns([Uploads::Id, Uploads::FolderName])
                    .from(Uploads::Table)
                    .and_where(Expr::col(Uploads::Id).eq(upload_id)),
            )
            .await?;
        let Some(upload) = upload else {
            return Ok(false);
        };
        self.db
            .execute(
                &self.db.pool,
                Query::update()
                    .table(Uploads::Table)
                    .value(
                        Uploads::StartedPartUploadCount,
                        Expr::col(Uploads::StartedPartUploadCount).add(1),
                    )
                    .and_where(Expr::col(Uploads::Id).eq(upload_id)),
            )
            .await?;
        self.adapter
            .upload_stream(
                &part_object(&upload.folder_name, part_index),
                stream,
                UploadKind::Part { length },
            )
            .await?;
        let recorded = self
            .db
            .execute(
                &self.db.pool,
                Query::update()
                    .table(Uploads::Table)
                    .values([
                        (Uploads::LastPartUploadedAt, now_ms().into()),
                        (
                            Uploads::FinishedPartUploadCount,
                            Expr::col(Uploads::FinishedPartUploadCount).add(1),
                        ),
                    ])
                    .and_where(Expr::col(Uploads::Id).eq(upload_id)),
            )
            .await?;
        Ok(recorded > 0)
    }

    /// Reserves `identity` for a new upload; a concurrent reservation of the same identity loses
    /// on the unique reservation hash.
    pub(crate) async fn create_upload(&self, identity: &EntryIdentity) -> Result<CreatedUpload> {
        let id = random_upload_id();
        let mut insert = Query::insert();
        insert
            .into_table(Uploads::Table)
            .columns([
                Uploads::Id,
                Uploads::FolderName,
                Uploads::CreatedAt,
                Uploads::Key,
                Uploads::Version,
                Uploads::Scope,
                Uploads::RepoId,
                Uploads::ReservationHash,
            ])
            .values([
                id.into(),
                id.to_string().into(),
                now_ms().into(),
                identity.key.as_str().into(),
                identity.version.as_str().into(),
                identity.scope.as_str().into(),
                identity.repo_id.as_str().into(),
                identity.reservation_hash().into(),
            ])?;
        match self.db.execute(&self.db.pool, &insert).await {
            Ok(_) => Ok(CreatedUpload::Created { id }),
            Err(failure) if is_unique_violation(&failure) => Ok(CreatedUpload::AlreadyExists),
            Err(failure) => Err(failure),
        }
    }

    pub(crate) async fn complete_upload(&self, identity: &EntryIdentity) -> Result<Option<Upload>> {
        let upload: Option<Upload> = self
            .db
            .optional(
                &self.db.reads,
                // Not `*`: `sqlx::Any` cannot decode Postgres' `char(64)` reservation hash.
                Query::select()
                    .columns([
                        Uploads::Id,
                        Uploads::Key,
                        Uploads::Version,
                        Uploads::Scope,
                        Uploads::RepoId,
                        Uploads::CreatedAt,
                        Uploads::LastPartUploadedAt,
                        Uploads::StartedPartUploadCount,
                        Uploads::FinishedPartUploadCount,
                        Uploads::FolderName,
                    ])
                    .from(Uploads::Table)
                    .and_where(Expr::col(Uploads::ReservationHash).eq(identity.reservation_hash())),
            )
            .await?;
        let Some(upload) = upload else {
            return Ok(None);
        };
        if upload.finished_part_upload_count == 0 {
            return Err(self
                .abandon_upload(&upload, "No parts have been uploaded".to_owned())
                .await);
        }
        if upload.started_part_upload_count != upload.finished_part_upload_count {
            let reason = format!(
                "Not all parts have been uploaded (only {} of {} parts uploaded)",
                upload.finished_part_upload_count, upload.started_part_upload_count
            );
            return Err(self.abandon_upload(&upload, reason).await);
        }
        let parts = self
            .adapter
            .list_folder(&parts_folder(&upload.folder_name))
            .await?;
        let part_count = i64::try_from(parts.len()).unwrap_or(i64::MAX);
        if part_count != upload.finished_part_upload_count {
            let reason = format!(
                "Uploaded part count does not match actual part count in storage (expected {} but \
                 found {part_count})",
                upload.finished_part_upload_count
            );
            return Err(self.abandon_upload(&upload, reason).await);
        }
        let size_bytes = parts
            .iter()
            .fold(0_u64, |total, part| total.saturating_add(part.bytes));
        let location = StorageLocation {
            id: uuid::Uuid::new_v4().to_string(),
            folder_name: upload.folder_name.clone(),
            part_count,
            merge_started_at: None,
            merged_at: None,
            parts_deleted_at: None,
            last_downloaded_at: None,
            size_bytes: Some(i64::try_from(size_bytes).unwrap_or(i64::MAX)),
        };

        self.promote_upload(identity, &upload, &location).await?;

        if let Err(error) = self.enforce_storage_budget().await {
            tracing::warn!(%error, "Capacity-based Eviction failed after upload completion");
        }
        if self.config.eager_merge && whole_object(&location).is_none() {
            // Eager Merge (ADR-0009): only the lease acquisition is awaited; the Merge itself
            // runs in the background.
            if let Err(error) = self
                .start_merge(&location, self.merge_parts(&location))
                .await
            {
                tracing::warn!(%error, "Eager Merge failed to start after upload completion");
            }
        }
        Ok(Some(upload))
    }

    /// Turns a completed upload into a storage location and points the cache entry at it.
    async fn promote_upload(
        &self,
        identity: &EntryIdentity,
        upload: &Upload,
        location: &StorageLocation,
    ) -> Result<()> {
        let mut tx = self.db.pool.begin().await?;
        insert_location(&self.db, &mut *tx, location).await?;
        let existing: Option<IdRow> = self
            .db
            .optional(
                &mut *tx,
                Query::select()
                    .column((CacheEntries::Table, CacheEntries::Id))
                    .from(CacheEntries::Table)
                    .join(
                        JoinType::InnerJoin,
                        StorageLocations::Table,
                        Expr::col((StorageLocations::Table, StorageLocations::Id))
                            .equals((CacheEntries::Table, CacheEntries::LocationId)),
                    )
                    .cond_where(entry_identity(identity))
                    .limit(1),
            )
            .await?;
        if let Some(existing) = existing {
            self.db
                .execute(
                    &mut *tx,
                    Query::update()
                        .table(CacheEntries::Table)
                        .values([
                            (CacheEntries::UpdatedAt, now_ms().into()),
                            (CacheEntries::LocationId, location.id.as_str().into()),
                        ])
                        .and_where(Expr::col(CacheEntries::Id).eq(existing.id)),
                )
                .await?;
        } else {
            let entry = CacheEntry {
                id: uuid::Uuid::new_v4().to_string(),
                key: upload.key.clone(),
                version: upload.version.clone(),
                scope: identity.scope.clone(),
                repo_id: identity.repo_id.clone(),
                updated_at: now_ms(),
                location_id: location.id.clone(),
            };
            insert_entry(&self.db, &mut *tx, &entry).await?;
        }
        self.db
            .execute(
                &mut *tx,
                Query::delete()
                    .from_table(Uploads::Table)
                    .and_where(Expr::col(Uploads::Id).eq(upload.id)),
            )
            .await?;
        tx.commit().await?;
        Ok(())
    }

    /// Capacity-based Eviction: once usage exceeds the Storage Budget, deletes entries by Cache
    /// Recency until usage is back at 90% of the budget (ADR-0008).
    pub(crate) async fn enforce_storage_budget(&self) -> Result<()> {
        let filesystem_usage = match self.config.cache_max_size_bytes {
            Some(_) => None,
            None => self.adapter.filesystem_usage().transpose()?,
        };
        let budget = match (self.config.cache_max_size_bytes, filesystem_usage) {
            (Some(budget), _) => budget.get(),
            (None, Some(usage)) => self
                .config
                .cache_filesystem_max_usage
                .of(usage.capacity_bytes),
            (None, None) => return Ok(()),
        };
        let target = budget.saturating_sub(budget.checked_div(10).unwrap_or(0));
        let mut usage = if let Some(usage) = filesystem_usage {
            usage.used_bytes
        } else {
            let total: TotalRow = self
                .db
                .one(
                    &self.db.pool,
                    Query::select()
                        .expr_as(
                            self.db.dialect.sum_bigint(&StorageLocations::SizeBytes),
                            Alias::new("total"),
                        )
                        .from(StorageLocations::Table),
                )
                .await?;
            u64::try_from(total.total).unwrap_or(0)
        };
        if budget == 0 || usage <= budget {
            return Ok(());
        }

        let candidates: Vec<EvictionCandidate> = self
            .db
            .all(
                &self.db.pool,
                Query::select()
                    .columns([
                        (StorageLocations::Table, StorageLocations::Id),
                        (StorageLocations::Table, StorageLocations::FolderName),
                        (StorageLocations::Table, StorageLocations::SizeBytes),
                    ])
                    .from(StorageLocations::Table)
                    .join(
                        JoinType::LeftJoin,
                        CacheEntries::Table,
                        Expr::col((CacheEntries::Table, CacheEntries::LocationId))
                            .equals((StorageLocations::Table, StorageLocations::Id)),
                    )
                    .and_where(no_active_reader_lease(None))
                    .order_by_expr(
                        Func::coalesce([
                            Expr::col((
                                StorageLocations::Table,
                                StorageLocations::LastDownloadedAt,
                            ))
                            .into(),
                            Expr::col((CacheEntries::Table, CacheEntries::UpdatedAt)).into(),
                            Expr::val(0).into(),
                        ])
                        .into(),
                        Order::Asc,
                    ),
            )
            .await?;

        for candidate in candidates {
            if usage <= target {
                break;
            }
            let mut tx = self.db.pool.begin().await?;
            let deletion =
                delete_storage_location_if_unread(&self.db, &mut tx, &candidate.id).await?;
            tx.commit().await?;
            if deletion != LocationDeletion::Deleted {
                continue;
            }
            self.adapter.delete_folder(&candidate.folder_name).await?;
            usage = match filesystem_usage.and_then(|_| self.adapter.filesystem_usage()) {
                Some(current) => current?.used_bytes,
                None => usage.saturating_sub(
                    candidate
                        .size_bytes
                        .and_then(|size| u64::try_from(size).ok())
                        .unwrap_or(0),
                ),
            };
        }
        Ok(())
    }

    /// Opens a download. Keyed by location, not entry: a re-save repoints the entry, but a
    /// location's bytes never change.
    pub(crate) async fn download(
        &self,
        location_id: &str,
        range: Option<RangeRequest>,
    ) -> Result<Option<DownloadStream>, DownloadError> {
        let mut tx = self.db.pool.begin().await.map_err(Failure::from)?;
        let location: Option<StorageLocation> = self
            .db
            .optional(
                &mut *tx,
                select_locations()
                    .join(
                        JoinType::InnerJoin,
                        CacheEntries::Table,
                        Expr::col((CacheEntries::Table, CacheEntries::LocationId))
                            .equals((StorageLocations::Table, StorageLocations::Id)),
                    )
                    .and_where(
                        Expr::col((StorageLocations::Table, StorageLocations::Id)).eq(location_id),
                    )
                    .limit(1)
                    .lock(LockType::Update),
            )
            .await?;
        let Some(location) = location else {
            return Ok(None);
        };
        let scope = whole_object(&location).map_or(ReaderLeaseScope::Parts, |(_, scope)| scope);
        let lease_id = create_reader_lease(
            &self.db,
            &mut *tx,
            &location.id,
            scope,
            deadline(LEASE_DURATION),
        )
        .await?;
        tx.commit().await.map_err(Failure::from)?;

        let (db, id) = (self.db.clone(), location.id.clone());
        drop(tokio::spawn(async move {
            let touched = db
                .execute(
                    &db.pool,
                    Query::update()
                        .table(StorageLocations::Table)
                        .value(StorageLocations::LastDownloadedAt, now_ms())
                        .and_where(Expr::col(StorageLocations::Id).eq(id)),
                )
                .await;
            if let Err(error) = touched {
                tracing::warn!(%error, "failed to record Cache Access");
            }
        }));

        let unserved = match self.open_location(&location, range).await {
            Ok(download) => {
                return Ok(Some(DownloadStream {
                    stream: self.protect(download.stream, lease_id),
                    ..download
                }));
            }
            Err(ReadError::NotFound(object)) => {
                tracing::warn!(location_id, object, "stale storage location");
                Ok(None)
            }
            Err(ReadError::RangeNotSatisfiable(_)) => Err(DownloadError::RangeNotSatisfiable {
                size: location
                    .size_bytes
                    .and_then(|size| u64::try_from(size).ok()),
            }),
            Err(ReadError::Failed(failure)) => Err(failure.into()),
        };
        if let Err(error) = release_reader_lease(&self.db, &lease_id).await {
            tracing::warn!(%error, lease_id, "failed to release Storage Reader Lease");
        }
        unserved
    }

    /// Streams a leased location, merging its Parts on the fly when no Merge has happened yet.
    async fn open_location(
        &self,
        location: &StorageLocation,
        range: Option<RangeRequest>,
    ) -> Result<DownloadStream, ReadError> {
        if whole_object(location).is_some() {
            return self.download_location(location, range).await;
        }
        self.ensure_parts_exist(location).await?;

        // Local Parts are cheap to read twice, so the client reads them at its own pace while
        // the Merge copies them in the background.
        if let Adapter::Filesystem(_) = self.adapter.as_ref() {
            self.start_merge_detached(location, self.merge_parts(location));
            return self.download_location(location, range).await;
        }
        // Object storage is read once and teed into the response and the Merge.
        let (merger_sender, merger_receiver) = mpsc::channel(1);
        let write = {
            let adapter = Arc::clone(&self.adapter);
            let merged = merged_object(&location.folder_name);
            let kind = UploadKind::Merged {
                length: location
                    .size_bytes
                    .and_then(|size| u64::try_from(size).ok()),
            };
            async move {
                adapter
                    .upload_stream(&merged, ReceiverStream::new(merger_receiver).boxed(), kind)
                    .await
            }
            .boxed()
        };
        if !self.start_merge(location, write).await? {
            return self.download_location(location, range).await;
        }
        let (response_sender, response_receiver) = mpsc::channel(1);
        drop(tokio::spawn(pump_parts(
            stream_parts(Arc::clone(&self.adapter), location),
            response_sender,
            merger_sender,
        )));
        Ok(DownloadStream {
            stream: ReceiverStream::new(response_receiver).boxed(),
            size: None,
            range: None,
        })
    }

    /// Matches like GitHub: scopes in order; within a scope the primary key, then each restore
    /// key; for each key an exact match before the newest entry it prefixes.
    pub(crate) async fn match_cache_entry(
        &self,
        query: &CacheQuery,
    ) -> Result<Option<CacheEntryMatch>> {
        let keys: Vec<&str> = std::iter::once(query.primary_key.as_str())
            .chain(query.restore_keys.iter().map(String::as_str))
            .collect();
        // Every (scope, key, exact) candidate, in the order matching tries them.
        let candidates = || {
            query.scopes.iter().flat_map(|scope| {
                keys.iter().enumerate().flat_map(move |(index, &key)| {
                    [(scope, index, key, true), (scope, index, key, false)]
                })
            })
        };
        let prefix = |key: &str| self.db.dialect.starts_with(CacheEntries::Key, key);
        let of_query = |select: &mut SelectStatement| {
            select
                .and_where(Expr::col(CacheEntries::Version).eq(query.version.as_str()))
                .and_where(Expr::col(CacheEntries::RepoId).eq(query.repo_id.as_str()))
                .and_where(
                    Expr::col(CacheEntries::Scope).is_in(query.scopes.iter().map(String::as_str)),
                )
                .to_owned()
        };

        // The common hit, the primary key in the first scope, straight from the key index.
        if let Some(scope) = query.scopes.first() {
            let exact = select_entries()
                .and_where(Expr::col(CacheEntries::Key).eq(query.primary_key.as_str()))
                .and_where(Expr::col(CacheEntries::Version).eq(query.version.as_str()))
                .and_where(Expr::col(CacheEntries::Scope).eq(scope.as_str()))
                .and_where(Expr::col(CacheEntries::RepoId).eq(query.repo_id.as_str()))
                .order_by(CacheEntries::UpdatedAt, Order::Desc)
                .limit(1)
                .to_owned();
            if let Some(entry) = self.db.optional(&self.db.reads, &exact).await? {
                return Ok(Some(CacheEntryMatch {
                    entry,
                    match_type: MatchType::ExactPrimary,
                }));
            }
        }

        // Everything else in one query: each row ranks by the first candidate it satisfies.
        let mut rank: Option<CaseStatement> = None;
        for (position, (scope, _, key, exact)) in candidates().enumerate() {
            let condition = Cond::all()
                .add(Expr::col(CacheEntries::Scope).eq(scope.as_str()))
                .add(if exact {
                    Expr::col(CacheEntries::Key).eq(key)
                } else {
                    prefix(key)
                });
            let position = i64::try_from(position).unwrap_or(i64::MAX);
            rank = Some(match rank {
                None => Expr::case(condition, position),
                Some(rank) => rank.case(condition, position),
            });
        }
        let Some(rank) = rank else {
            return Ok(None);
        };
        let ranked = of_query(
            select_entries()
                .expr_as(rank.finally(i64::MAX), Alias::new("matchRank"))
                .cond_where(
                    keys.iter()
                        .fold(Cond::any(), |any, key| any.add(prefix(key))),
                )
                .order_by(Alias::new("matchRank"), Order::Asc)
                .order_by(CacheEntries::UpdatedAt, Order::Desc)
                .limit(1),
        );
        let best: Option<RankedEntry> = self.db.optional(&self.db.reads, &ranked).await?;
        let Some((best, (_, index, _, exact))) = best.and_then(|best| {
            let candidate = usize::try_from(best.match_rank)
                .ok()
                .and_then(|position| candidates().nth(position))?;
            Some((best, candidate))
        }) else {
            return Ok(None);
        };
        let match_type = match (index == 0, exact) {
            (true, true) => MatchType::ExactPrimary,
            (true, false) => MatchType::PrefixedPrimary,
            (false, true) => MatchType::ExactRestore,
            (false, false) => MatchType::PrefixedRestore,
        };
        Ok(Some(CacheEntryMatch {
            entry: best.entry,
            match_type,
        }))
    }

    /// Matches a cache entry and hands out a URL to download it from.
    ///
    /// Returning a download URL is a promise the data exists: the client commits to downloading
    /// and can't walk a later 404 back to a cache miss (`BuildKit` hard-fails the build). So
    /// storage is validated before handing out a URL: a Dangling Cache Entry is self-healed and
    /// matching retried, so a valid candidate under another restore key still wins (ADR-0005).
    pub(crate) async fn cache_entry_with_download_url(
        &self,
        query: &CacheQuery,
    ) -> Result<Option<DownloadUrlMatch>> {
        for _attempt in 0..MAX_DANGLING_PURGE_ATTEMPTS {
            let Some(matched) = self.match_cache_entry(query).await? else {
                return Ok(None);
            };
            let entry = matched.entry;
            let location: Option<StorageLocation> = self
                .db
                .optional(
                    &self.db.reads,
                    select_locations().and_where(
                        Expr::col((StorageLocations::Table, StorageLocations::Id))
                            .eq(entry.location_id.as_str()),
                    ),
                )
                .await?;
            let location = match location {
                Some(location) if self.storage_has_data(&location).await? => location,
                Some(_) | None => {
                    tracing::warn!(
                        entry_id = entry.id,
                        key = entry.key,
                        "purging Dangling Cache Entry"
                    );
                    self.purge_dangling_cache_entry(&entry.id, &entry.location_id)
                        .await?;
                    continue;
                }
            };

            let default_url = format!(
                "{}/download/{}",
                self.config.api_base_url, entry.location_id
            );
            let (true, Some(_), Adapter::Object(store)) = (
                self.config.enable_direct_downloads,
                whole_object(&location),
                self.adapter.as_ref(),
            ) else {
                return Ok(Some(DownloadUrlMatch {
                    download_url: default_url,
                    entry,
                }));
            };

            // An entry in one object with direct downloads enabled: take a reader lease bounded by
            // the signed URL lifetime, then sign. One deadline bounds both, so the URL never outlives
            // the lease.
            let expires_at = deadline(DIRECT_DOWNLOAD_LEASE_DURATION);
            let mut tx = self.db.pool.begin().await?;
            let current: Option<StorageLocation> = self
                .db
                .optional(
                    &mut *tx,
                    select_locations()
                        .and_where(
                            Expr::col((StorageLocations::Table, StorageLocations::Id))
                                .eq(location.id.as_str()),
                        )
                        .lock(LockType::Update),
                )
                .await?;
            let current = current.ok_or_else(|| Failure::msg("Storage location not found"))?;
            let whole = whole_object(&current);
            if let Some((_, scope)) = &whole {
                create_reader_lease(&self.db, &mut *tx, &current.id, *scope, expires_at).await?;
                self.db
                    .execute(
                        &mut *tx,
                        Query::update()
                            .table(StorageLocations::Table)
                            .value(StorageLocations::LastDownloadedAt, now_ms())
                            .and_where(Expr::col(StorageLocations::Id).eq(current.id.as_str())),
                    )
                    .await?;
            }
            tx.commit().await?;

            // The merge could have been undone between validation and the lease read.
            let download_url = match whole {
                Some((object, _)) => {
                    store
                        .create_download_url(
                            &object,
                            Duration::from_millis(
                                u64::try_from(expires_at.saturating_sub(now_ms())).unwrap_or(0),
                            ),
                        )
                        .await?
                }
                None => default_url,
            };
            return Ok(Some(DownloadUrlMatch {
                download_url,
                entry,
            }));
        }
        tracing::warn!("exhausted Dangling Cache Entry purge attempts; returning cache miss");
        Ok(None)
    }

    /// Deletes a storage location row, then its data (ADR-0001), unless a reader holds it
    /// (ADR-0002). Data that can't be deleted is left as Orphaned Storage.
    pub(crate) async fn delete_storage_location(&self, id: &str) -> Result<LocationDeletion> {
        let location: Option<StorageLocation> = self
            .db
            .optional(
                &self.db.pool,
                select_locations()
                    .and_where(Expr::col((StorageLocations::Table, StorageLocations::Id)).eq(id)),
            )
            .await?;
        let Some(location) = location else {
            return Ok(LocationDeletion::Missing);
        };
        let mut tx = self.db.pool.begin().await?;
        let deletion = delete_storage_location_if_unread(&self.db, &mut tx, id).await?;
        tx.commit().await?;
        if deletion != LocationDeletion::Deleted {
            return Ok(deletion);
        }
        if let Err(error) = self.adapter.delete_folder(&location.folder_name).await {
            tracing::warn!(%error, id, "storage location data left as Orphaned Storage");
        }
        Ok(LocationDeletion::Deleted)
    }
}

/// A random id of at most ten decimal digits, like the original server's upload ids; the folder
/// of the upload's Parts is named after it.
fn random_upload_id() -> i64 {
    let (random, _) = uuid::Uuid::new_v4().as_u64_pair();
    random.cast_signed().rem_euclid(10_000_000_000)
}

/// A cache entry with the position of the first match candidate it satisfies.
#[derive(Debug, sqlx::FromRow)]
#[sqlx(rename_all = "camelCase")]
struct RankedEntry {
    #[sqlx(flatten)]
    entry: CacheEntry,
    match_rank: i64,
}

/// A location Capacity-based Eviction may delete.
#[derive(Debug, sqlx::FromRow)]
#[sqlx(rename_all = "camelCase")]
struct EvictionCandidate {
    id: String,
    #[sqlx(try_from = "crate::db::Utf8Text")]
    folder_name: String,
    size_bytes: Option<i64>,
}

/// Takes the Merge Lease and records the Merge as started; `None` while another worker holds it.
async fn claim_merge(db: &Db, id: &str) -> Result<Option<String>> {
    let Some(token) = acquire_merge_lease(db, id).await? else {
        return Ok(None);
    };
    db.execute(
        &db.pool,
        Query::update()
            .table(StorageLocations::Table)
            .value(StorageLocations::MergeStartedAt, now_ms())
            .and_where(Expr::col(StorageLocations::Id).eq(id)),
    )
    .await?;
    Ok(Some(token))
}

/// Writes the merged object under the lease `token`, then marks the Merge complete.
async fn run_merge(db: Db, id: String, token: String, write: BoxFuture<'static, Result<()>>) {
    let renewal = {
        let (db, id, token) = (db.clone(), id.clone(), token.clone());
        keep_renewing(move || {
            let (db, id, token) = (db.clone(), id.clone(), token.clone());
            async move {
                // A transient failure must not end the renewal: the merged object would then be
                // thrown away once the lease expires mid-merge.
                renew_merge_lease(&db, &id, &token).await.or_else(|error| {
                    tracing::warn!(%error, storage_location_id = id, "failed to renew Merge Lease");
                    Ok(true)
                })
            }
        })
    };
    let merged = async {
        write.await?;
        // The merged object is already written, so losing a deadlock here must not throw the
        // merge away; the fence is re-checked on every attempt.
        retry_on_lock_conflict(|| complete_merge(&db, &id, &token)).await
    }
    .await;
    if let Err(error) = merged {
        tracing::error!(%error, storage_location_id = id, "merge failed");
        if let Err(rollback_error) = roll_back_merge(&db, &id, &token).await {
            tracing::error!(%rollback_error, storage_location_id = id, "failed to roll back merge");
        }
    }
    drop(renewal);
    if let Err(error) = release_merge_lease(&db, &id, &token).await {
        tracing::warn!(%error, storage_location_id = id, "failed to release Merge Lease");
    }
}

async fn complete_merge(db: &Db, id: &str, token: &str) -> Result<()> {
    #[derive(Debug, sqlx::FromRow)]
    #[sqlx(rename_all = "camelCase")]
    struct Lease {
        token: String,
        expires_at: i64,
    }
    let mut tx = db.pool.begin().await?;
    let lease: Option<Lease> = db
        .optional(
            &mut *tx,
            Query::select()
                .columns([MergeLeases::Token, MergeLeases::ExpiresAt])
                .from(MergeLeases::Table)
                .and_where(Expr::col(MergeLeases::StorageLocationId).eq(id))
                .lock(LockType::Update),
        )
        .await?;
    if !lease.is_some_and(|lease| lease.token == token && lease.expires_at > now_ms()) {
        return Err(Failure::msg("Merge lease was lost before completion"));
    }
    db.execute(
        &mut *tx,
        Query::update()
            .table(StorageLocations::Table)
            .value(StorageLocations::MergedAt, now_ms())
            .and_where(Expr::col(StorageLocations::Id).eq(id)),
    )
    .await?;
    tx.commit().await?;
    Ok(())
}

async fn roll_back_merge(db: &Db, id: &str, token: &str) -> Result<()> {
    let mut holds_lease = Query::select();
    holds_lease
        .column(MergeLeases::StorageLocationId)
        .from(MergeLeases::Table)
        .and_where(
            Expr::col((MergeLeases::Table, MergeLeases::StorageLocationId))
                .equals((StorageLocations::Table, StorageLocations::Id)),
        )
        .and_where(Expr::col((MergeLeases::Table, MergeLeases::Token)).eq(token));
    db.execute(
        &db.pool,
        Query::update()
            .table(StorageLocations::Table)
            .values([
                (StorageLocations::MergedAt, Option::<i64>::None.into()),
                (StorageLocations::MergeStartedAt, Option::<i64>::None.into()),
            ])
            .and_where(Expr::col(StorageLocations::Id).eq(id))
            .and_where(Expr::exists(holds_lease)),
    )
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    const CHUNKS: usize = 24;

    fn chunks() -> ByteStream {
        stream::iter((0..CHUNKS).map(|_| Ok(Bytes::from(vec![1_u8; 64 * 1024])))).boxed()
    }

    /// Drains a receiver, pausing after every chunk.
    async fn consume(mut chunks: mpsc::Receiver<io::Result<Bytes>>, pause: Duration) -> usize {
        let mut total = 0_usize;
        while let Some(chunk) = chunks.recv().await {
            total = total.saturating_add(chunk.unwrap().len());
            tokio::time::sleep(pause).await;
        }
        total
    }

    // Regression for #247: sinks consumed at different rates must not deadlock the tee.
    #[tokio::test]
    async fn tees_parts_to_readers_of_different_speeds() {
        let (response, response_receiver) = mpsc::channel(1);
        let (merger, merger_receiver) = mpsc::channel(1);
        let pump = tokio::spawn(pump_parts(chunks(), response, merger));
        let slow = consume(response_receiver, Duration::from_millis(5));
        let fast = consume(merger_receiver, Duration::ZERO);
        let (slow, fast) =
            tokio::time::timeout(Duration::from_secs(5), async { tokio::join!(slow, fast) })
                .await
                .unwrap();
        pump.await.unwrap();
        assert_eq!(
            (slow, fast),
            (CHUNKS * 64 * 1024, CHUNKS * 64 * 1024),
            "both get every byte"
        );
    }

    #[tokio::test]
    async fn keeps_merging_after_the_client_goes_away() {
        let (response, response_receiver) = mpsc::channel(1);
        let (merger, merger_receiver) = mpsc::channel(1);
        drop(response_receiver);
        let pump = tokio::spawn(pump_parts(chunks(), response, merger));
        let merge_input = consume(merger_receiver, Duration::ZERO).await;
        pump.await.unwrap();
        assert_eq!(
            merge_input,
            CHUNKS * 64 * 1024,
            "the merge still gets every byte"
        );
    }
}
