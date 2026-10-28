//! Periodic cleanup tasks and their schedule.

use std::collections::HashSet;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use futures_util::{StreamExt as _, stream};
use sea_orm::ActiveValue::Set;
use sea_orm::sea_query::{Expr, ExprTrait as _};
use sea_orm::{
    ColumnTrait as _, Condition, EntityTrait as _, QueryFilter as _, QuerySelect as _,
    QueryTrait as _, Select, TransactionTrait as _,
};
use tokio::time::MissedTickBehavior;

use crate::config::Config;
use crate::db::{
    ReaderLeaseScope, cache_entries, merge_leases, now_ms, storage_locations,
    storage_reader_leases, uploads,
};
use crate::error::{Failure, Result};
use crate::storage::{
    LocationDeletion, Storage, claim_parts_deletion_if_unread, delete_storage_location_if_unread,
    no_active_reader_lease, parts_folder,
};

const PAGE_SIZE: u8 = 10;
const MINUTE_MS: i64 = 60 * 1000;
const ORPHAN_DELETE_CONCURRENCY: usize = 5;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum Task {
    /// Delete uploads without activity for over a minute.
    Uploads,
    /// Delete cache entries older than the configured retention period.
    CacheEntries,
    /// Delete grace-expired storage folders not authorized by database records.
    OrphanedStorage,
    /// Delete Parts of merged cache entries.
    Parts,
    /// Delete storage locations not associated with any cache entry.
    StorageLocations,
    /// Reset stalled merges and purge expired leases.
    Merges,
}

impl Task {
    const fn name(self) -> &'static str {
        match self {
            Self::Uploads => "cleanup:uploads",
            Self::CacheEntries => "cleanup:cache-entries",
            Self::OrphanedStorage => "cleanup:orphaned-storage",
            Self::Parts => "cleanup:parts",
            Self::StorageLocations => "cleanup:storage-locations",
            Self::Merges => "cleanup:merges",
        }
    }
}

/// How often each schedule runs, and the tasks it runs in order.
const SCHEDULES: [(Duration, &[Task]); 4] = [
    (Duration::from_mins(5), &[Task::Uploads]),
    (
        Duration::from_mins(10),
        &[Task::Parts, Task::StorageLocations],
    ),
    (Duration::from_hours(1), &[Task::Merges]),
    (
        Duration::from_hours(24),
        &[Task::CacheEntries, Task::OrphanedStorage],
    ),
];

/// What a cleanup run did; counters a task does not touch stay zero.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct CleanupSummary {
    pub(crate) skipped: bool,
    pub(crate) deleted_uploads: u64,
    pub(crate) deleted_locations: u64,
    pub(crate) deleted_parts: u64,
    pub(crate) deleted_folders: u64,
    pub(crate) deleted_objects: u64,
    pub(crate) deleted_bytes: u64,
    pub(crate) inspected_folders: u64,
    pub(crate) authorized_folders: u64,
    pub(crate) grace_period_folders: u64,
    pub(crate) updated: u64,
    pub(crate) failures: u64,
    pub(crate) duration_ms: u64,
}

impl CleanupSummary {
    const fn reclaimed(&mut self, objects: u64, bytes: u64) {
        self.deleted_objects = self.deleted_objects.saturating_add(objects);
        self.deleted_bytes = self.deleted_bytes.saturating_add(bytes);
    }

    fn failed(&mut self, failures: &mut Vec<Failure>, failure: Failure) {
        self.failures = self.failures.saturating_add(1);
        failures.push(failure);
    }
}

/// Marks a task as running until dropped, even if the task panics.
struct Running<'a> {
    tasks: &'a Mutex<HashSet<Task>>,
    task: Task,
}

impl Drop for Running<'_> {
    fn drop(&mut self) {
        self.tasks
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(&self.task);
    }
}

/// Runs cleanup tasks; a task already running is not started twice.
#[derive(Debug)]
pub(crate) struct Cleanup {
    storage: Arc<Storage>,
    disabled: bool,
    retention: Option<Duration>,
    orphan_grace_period: Duration,
    running: Mutex<HashSet<Task>>,
}

impl Cleanup {
    pub(crate) fn new(storage: Arc<Storage>, config: &Config) -> Self {
        Self {
            storage,
            disabled: config.disable_cleanup_jobs,
            retention: config.cache_retention,
            orphan_grace_period: config.orphaned_storage_grace_period,
            running: Mutex::new(HashSet::new()),
        }
    }

    /// Runs a task unless it is already running; `None` when skipped for that reason.
    pub(crate) async fn run(&self, task: Task) -> Option<Result<CleanupSummary>> {
        if !self
            .running
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(task)
        {
            tracing::debug!(task = task.name(), "cleanup task already running");
            return None;
        }
        let running = Running {
            tasks: &self.running,
            task,
        };
        let started = Instant::now();
        let mut summary = CleanupSummary {
            skipped: self.disabled || (task == Task::CacheEntries && self.retention.is_none()),
            ..CleanupSummary::default()
        };
        let mut failures = Vec::new();
        let outcome = if summary.skipped {
            Ok(())
        } else {
            match task {
                Task::Uploads => self.uploads(&mut summary, &mut failures).await,
                Task::CacheEntries => self.cache_entries(&mut summary, &mut failures).await,
                Task::OrphanedStorage => {
                    reconcile_orphaned_storage(
                        &self.storage,
                        self.orphan_grace_period,
                        now_ms(),
                        &mut summary,
                        &mut failures,
                    )
                    .await
                }
                Task::Parts => self.parts(&mut summary, &mut failures).await,
                Task::StorageLocations => self.storage_locations(&mut summary, &mut failures).await,
                Task::Merges => self.merges(&mut summary).await,
            }
        };
        drop(running);
        summary.duration_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);

        let failure = match outcome {
            Err(failure) => {
                summary.failures = summary.failures.saturating_add(1);
                Some(failure)
            }
            Ok(()) => failures.into_iter().next(),
        };
        tracing::info!(task = task.name(), ?summary, "cleanup run completed");
        if let Some(failure) = &failure {
            tracing::error!(task = task.name(), ?summary, error = %failure, "cleanup run failed");
        }
        Some(failure.map_or(Ok(summary), Err))
    }

    /// Starts a task in the background.
    pub(crate) fn trigger(self: &Arc<Self>, task: Task) {
        let cleanup = Arc::clone(self);
        drop(tokio::spawn(async move { cleanup.run(task).await }));
    }

    /// Runs every schedule until the process ends.
    pub(crate) fn spawn_schedules(self: &Arc<Self>) {
        for (period, tasks) in SCHEDULES {
            let cleanup = Arc::clone(self);
            drop(tokio::spawn(async move {
                let mut ticks = tokio::time::interval(period);
                // A run that outlasts its period skips the ticks it missed instead of bunching
                // them.
                ticks.set_missed_tick_behavior(MissedTickBehavior::Skip);
                // The first tick is immediate, so a process restarted more often than a period
                // still runs every task.
                loop {
                    ticks.tick().await;
                    for &task in tasks {
                        // Its own task, so a panic fails one run instead of ending the schedule.
                        let cleanup = Arc::clone(&cleanup);
                        if let Err(error) =
                            tokio::spawn(async move { cleanup.run(task).await }).await
                        {
                            tracing::error!(task = task.name(), %error, "cleanup run panicked");
                        }
                    }
                }
            }));
        }
    }

    async fn uploads(
        &self,
        summary: &mut CleanupSummary,
        failures: &mut Vec<Failure>,
    ) -> Result<()> {
        let db = &self.storage.db;
        let cutoff = now_ms().saturating_sub(MINUTE_MS);
        loop {
            let stalled: Vec<(i64, String)> = uploads::Entity::find()
                .select_only()
                .columns([uploads::Column::Id, uploads::Column::FolderName])
                .filter(
                    Condition::any()
                        .add(uploads::COLUMN.last_part_uploaded_at.is_null())
                        .add(uploads::COLUMN.last_part_uploaded_at.lt(cutoff)),
                )
                .filter(uploads::COLUMN.created_at.lt(cutoff))
                .limit(u64::from(PAGE_SIZE))
                .into_tuple()
                .all(&db.pool)
                .await?;
            for (id, folder_name) in &stalled {
                uploads::Entity::delete_by_id(*id).exec(&db.pool).await?;
                summary.deleted_uploads = summary.deleted_uploads.saturating_add(1);
                match self.storage.adapter.delete_folder(folder_name).await {
                    Ok(deleted) => summary.reclaimed(deleted.objects, deleted.bytes),
                    Err(failure) => summary.failed(failures, failure),
                }
            }
            if stalled.len() < PAGE_SIZE.into() {
                return Ok(());
            }
        }
    }

    /// Deletes locations returned page by page, each re-checked for readers in a transaction.
    async fn delete_locations(
        &self,
        query: Select<storage_locations::Entity>,
        summary: &mut CleanupSummary,
        failures: &mut Vec<Failure>,
    ) -> Result<()> {
        let db = &self.storage.db;
        let query = query.filter(no_active_reader_lease(None));
        loop {
            let locations = folders(query.clone()).all(&db.pool).await?;
            for (id, folder_name) in &locations {
                let tx = db.pool.begin().await?;
                let deletion = delete_storage_location_if_unread(&tx, id).await?;
                tx.commit().await?;
                if deletion != LocationDeletion::Deleted {
                    continue;
                }
                summary.deleted_locations = summary.deleted_locations.saturating_add(1);
                match self.storage.adapter.delete_folder(folder_name).await {
                    Ok(reclaimed) => summary.reclaimed(reclaimed.objects, reclaimed.bytes),
                    Err(failure) => summary.failed(failures, failure),
                }
            }
            if locations.len() < PAGE_SIZE.into() {
                return Ok(());
            }
        }
    }

    async fn cache_entries(
        &self,
        summary: &mut CleanupSummary,
        failures: &mut Vec<Failure>,
    ) -> Result<()> {
        // Runs only with a retention period; without one the run is marked skipped.
        let Some(retention) = self.retention else {
            return Ok(());
        };
        let retention_ms = i64::try_from(retention.as_millis()).unwrap_or(i64::MAX);
        let cutoff = now_ms().saturating_sub(retention_ms);
        let last_downloaded = storage_locations::COLUMN.last_downloaded_at;
        let query = storage_locations::Entity::find()
            .inner_join(cache_entries::Entity)
            .filter(cache_entries::COLUMN.updated_at.lt(cutoff))
            .filter(
                Condition::any()
                    .add(last_downloaded.is_null())
                    .add(last_downloaded.lt(cutoff)),
            );
        self.delete_locations(query, summary, failures).await
    }

    async fn storage_locations(
        &self,
        summary: &mut CleanupSummary,
        failures: &mut Vec<Failure>,
    ) -> Result<()> {
        let query = storage_locations::Entity::find()
            .left_join(cache_entries::Entity)
            .filter(cache_entries::COLUMN.id.is_null());
        self.delete_locations(query, summary, failures).await
    }

    async fn parts(&self, summary: &mut CleanupSummary, failures: &mut Vec<Failure>) -> Result<()> {
        let db = &self.storage.db;
        let query = storage_locations::Entity::find()
            .filter(storage_locations::COLUMN.merged_at.is_not_null())
            .filter(storage_locations::COLUMN.parts_deleted_at.is_null())
            .filter(no_active_reader_lease(Some(ReaderLeaseScope::Parts)));
        loop {
            let locations = folders(query.clone()).all(&db.pool).await?;
            let failures_before = failures.len();
            for (id, folder_name) in &locations {
                let tx = db.pool.begin().await?;
                let claimed = claim_parts_deletion_if_unread(&tx, id).await?;
                tx.commit().await?;
                if !claimed {
                    continue;
                }
                match self
                    .storage
                    .adapter
                    .delete_folder(&parts_folder(folder_name))
                    .await
                {
                    Ok(deleted) => {
                        summary.deleted_parts =
                            summary.deleted_parts.saturating_add(deleted.objects);
                        summary.deleted_bytes = summary.deleted_bytes.saturating_add(deleted.bytes);
                    }
                    Err(failure) => {
                        storage_locations::Entity::update_many()
                            .set(storage_locations::ActiveModel {
                                parts_deleted_at: Set(None),
                                ..Default::default()
                            })
                            .filter(storage_locations::COLUMN.id.eq(id))
                            .exec(&db.pool)
                            .await?;
                        summary.failed(failures, failure);
                    }
                }
            }
            // A failed deletion makes its location eligible again; paging on would retry it
            // forever, so the next scheduled run picks it up instead.
            if locations.len() < PAGE_SIZE.into() || failures.len() > failures_before {
                return Ok(());
            }
        }
    }

    async fn merges(&self, summary: &mut CleanupSummary) -> Result<()> {
        let db = &self.storage.db;
        let now = now_ms();
        let live_lease = merge_leases::Entity::find()
            .select_only()
            .column(merge_leases::Column::StorageLocationId)
            .filter(
                merge_leases::Column::StorageLocationId
                    .into_expr()
                    .equals((storage_locations::Entity, storage_locations::Column::Id)),
            )
            .filter(merge_leases::COLUMN.expires_at.gt(now))
            .into_query();
        summary.updated = storage_locations::Entity::update_many()
            .set(storage_locations::ActiveModel {
                merge_started_at: Set(None),
                merged_at: Set(None),
                ..Default::default()
            })
            .filter(
                storage_locations::COLUMN
                    .merge_started_at
                    .lt(now.saturating_sub(15 * MINUTE_MS)),
            )
            .filter(storage_locations::COLUMN.merged_at.is_null())
            .filter(Expr::exists(live_lease).not())
            .exec(&db.pool)
            .await?
            .rows_affected;
        merge_leases::Entity::delete_many()
            .filter(merge_leases::COLUMN.expires_at.lte(now))
            .exec(&db.pool)
            .await?;
        // Expired Storage Reader Leases are otherwise only removed by stream teardown or location
        // cascade; direct-download leases rely on this purge.
        storage_reader_leases::Entity::delete_many()
            .filter(storage_reader_leases::COLUMN.expires_at.lte(now))
            .exec(&db.pool)
            .await?;
        Ok(())
    }
}

/// A page of the ids and folder names of the locations `query` selects.
fn folders(
    query: Select<storage_locations::Entity>,
) -> sea_orm::Selector<sea_orm::SelectGetableTuple<(String, String)>> {
    query
        .select_only()
        .columns([
            storage_locations::Column::Id,
            storage_locations::Column::FolderName,
        ])
        .limit(u64::from(PAGE_SIZE))
        .into_tuple()
}

/// Deletes stored folders that no database record authorizes once they are older than the grace
/// period, as of `now`.
pub(crate) async fn reconcile_orphaned_storage(
    storage: &Storage,
    grace_period: Duration,
    now: i64,
    summary: &mut CleanupSummary,
    failures: &mut Vec<Failure>,
) -> Result<()> {
    let (db, adapter) = (&storage.db, &storage.adapter);
    // Inventory must complete before any deletion. A partial listing must never be mistaken for
    // evidence that an object is orphaned.
    let stored = adapter.list_storage_folders().await?;
    let locations: Vec<String> = storage_locations::Entity::find()
        .select_only()
        .column(storage_locations::Column::FolderName)
        .into_tuple()
        .all(&db.pool)
        .await?;
    let uploads: Vec<String> = uploads::Entity::find()
        .select_only()
        .column(uploads::Column::FolderName)
        .into_tuple()
        .all(&db.pool)
        .await?;
    let authorized: HashSet<String> = locations.into_iter().chain(uploads).collect();
    let cutoff = now.saturating_sub(i64::try_from(grace_period.as_millis()).unwrap_or(i64::MAX));

    let mut orphaned = Vec::new();
    for folder in stored {
        summary.inspected_folders = summary.inspected_folders.saturating_add(1);
        if authorized.contains(&folder.folder_name) {
            summary.authorized_folders = summary.authorized_folders.saturating_add(1);
        } else if folder.updated_at > cutoff {
            summary.grace_period_folders = summary.grace_period_folders.saturating_add(1);
        } else {
            orphaned.push(folder.folder_name);
        }
    }

    let results: Vec<_> = stream::iter(orphaned)
        .map(|folder| async move { adapter.delete_folder(&folder).await })
        .buffer_unordered(ORPHAN_DELETE_CONCURRENCY)
        .collect()
        .await;
    for result in results {
        match result {
            Ok(deleted) => {
                summary.deleted_folders = summary.deleted_folders.saturating_add(1);
                summary.reclaimed(deleted.objects, deleted.bytes);
            }
            Err(failure) => summary.failed(failures, failure),
        }
    }
    Ok(())
}
