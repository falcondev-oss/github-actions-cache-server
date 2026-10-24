//! Periodic cleanup tasks and their schedule.

use std::collections::HashSet;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use chrono::{DateTime, DurationRound as _, Local, LocalResult, TimeDelta, TimeZone};
use futures_util::{StreamExt as _, stream};
use sea_query::{Cond, Expr, JoinType, Query, SelectStatement};

use crate::config::Config;
use crate::db::{
    CacheEntries, FolderRow, MergeLeases, ReaderLeaseScope, StorageLocations, StorageReaderLeases,
    UploadFolder, Uploads, Utf8Text, now_ms,
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

/// Schedules aligned to local wall-clock time like the original cron expressions, in minutes that
/// divide a day, and the tasks each runs in order.
const SCHEDULES: [(u32, &[Task]); 4] = [
    (5, &[Task::Uploads]),
    (10, &[Task::Parts, Task::StorageLocations]),
    (60, &[Task::Merges]),
    (24 * 60, &[Task::CacheEntries, Task::OrphanedStorage]),
];

/// The next local time after `now` whose minute of the day is a multiple of `period_minutes`.
fn next_run<Tz: TimeZone>(now: &DateTime<Tz>, period_minutes: u32) -> DateTime<Tz> {
    let period = TimeDelta::minutes(period_minutes.into());
    // Periods divide a day, so truncating the naive local time aligns them to local midnight.
    // Like cron, boundaries a DST change skips are passed over, and a repeated one runs once.
    let boundaries = now.naive_local().duration_trunc(period).ok();
    std::iter::successors(boundaries, |boundary| boundary.checked_add_signed(period))
        .find_map(
            |boundary| match now.timezone().from_local_datetime(&boundary) {
                LocalResult::Single(time) => Some(time).filter(|time| time > now),
                // `Local` lists the two occurrences latest first.
                LocalResult::Ambiguous(first, second) => {
                    [first, second].into_iter().filter(|time| time > now).min()
                }
                LocalResult::None => None,
            },
        )
        .unwrap_or_else(|| now.clone())
}

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
        for (period_minutes, tasks) in SCHEDULES {
            let cleanup = Arc::clone(self);
            drop(tokio::spawn(async move {
                loop {
                    let now = Local::now();
                    let wait = next_run(&now, period_minutes)
                        .signed_duration_since(now)
                        .to_std()
                        .unwrap_or_default();
                    tokio::time::sleep(wait).await;
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
            let uploads: Vec<UploadFolder> = db
                .all(
                    &db.pool,
                    Query::select()
                        .columns([Uploads::Id, Uploads::FolderName])
                        .from(Uploads::Table)
                        .cond_where(
                            Cond::all()
                                .add(
                                    Cond::any()
                                        .add(Expr::col(Uploads::LastPartUploadedAt).is_null())
                                        .add(Expr::col(Uploads::LastPartUploadedAt).lt(cutoff)),
                                )
                                .add(Expr::col(Uploads::CreatedAt).lt(cutoff)),
                        )
                        .limit(PAGE_SIZE.into()),
                )
                .await?;
            for upload in &uploads {
                db.execute(
                    &db.pool,
                    Query::delete()
                        .from_table(Uploads::Table)
                        .and_where(Expr::col(Uploads::Id).eq(upload.id)),
                )
                .await?;
                summary.deleted_uploads = summary.deleted_uploads.saturating_add(1);
                match self
                    .storage
                    .adapter
                    .delete_folder(&upload.folder_name)
                    .await
                {
                    Ok(deleted) => summary.reclaimed(deleted.objects, deleted.bytes),
                    Err(failure) => summary.failed(failures, failure),
                }
            }
            if uploads.len() < PAGE_SIZE.into() {
                return Ok(());
            }
        }
    }

    /// Deletes locations returned page by page, each re-checked for readers in a transaction.
    async fn delete_locations(
        &self,
        query: &SelectStatement,
        summary: &mut CleanupSummary,
        failures: &mut Vec<Failure>,
    ) -> Result<()> {
        let db = &self.storage.db;
        loop {
            let locations: Vec<FolderRow> = db.all(&db.pool, query).await?;
            for location in &locations {
                let mut tx = db.pool.begin().await?;
                let deletion = delete_storage_location_if_unread(db, &mut tx, &location.id).await?;
                tx.commit().await?;
                if deletion != LocationDeletion::Deleted {
                    continue;
                }
                summary.deleted_locations = summary.deleted_locations.saturating_add(1);
                match self
                    .storage
                    .adapter
                    .delete_folder(&location.folder_name)
                    .await
                {
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
        let last_downloaded =
            || Expr::col((StorageLocations::Table, StorageLocations::LastDownloadedAt));
        let updated = || Expr::col((CacheEntries::Table, CacheEntries::UpdatedAt));
        let query = Query::select()
            .columns([
                (StorageLocations::Table, StorageLocations::Id),
                (StorageLocations::Table, StorageLocations::FolderName),
            ])
            .from(StorageLocations::Table)
            .join(
                JoinType::InnerJoin,
                CacheEntries::Table,
                Expr::col((CacheEntries::Table, CacheEntries::LocationId))
                    .equals((StorageLocations::Table, StorageLocations::Id)),
            )
            .and_where(updated().lt(cutoff))
            .cond_where(
                Cond::any()
                    .add(last_downloaded().is_null())
                    .add(last_downloaded().lt(cutoff)),
            )
            .and_where(no_active_reader_lease(None))
            .limit(PAGE_SIZE.into())
            .to_owned();
        self.delete_locations(&query, summary, failures).await
    }

    async fn storage_locations(
        &self,
        summary: &mut CleanupSummary,
        failures: &mut Vec<Failure>,
    ) -> Result<()> {
        let mut referenced = Query::select();
        referenced
            .column((CacheEntries::Table, CacheEntries::Id))
            .from(CacheEntries::Table)
            .and_where(
                Expr::col((CacheEntries::Table, CacheEntries::LocationId))
                    .equals((StorageLocations::Table, StorageLocations::Id)),
            );
        let query = Query::select()
            .columns([
                (StorageLocations::Table, StorageLocations::Id),
                (StorageLocations::Table, StorageLocations::FolderName),
            ])
            .from(StorageLocations::Table)
            .and_where(Expr::exists(referenced).not())
            .and_where(no_active_reader_lease(None))
            .limit(PAGE_SIZE.into())
            .to_owned();
        self.delete_locations(&query, summary, failures).await
    }

    async fn parts(&self, summary: &mut CleanupSummary, failures: &mut Vec<Failure>) -> Result<()> {
        let db = &self.storage.db;
        loop {
            let locations: Vec<FolderRow> = db
                .all(
                    &db.pool,
                    Query::select()
                        .columns([
                            (StorageLocations::Table, StorageLocations::Id),
                            (StorageLocations::Table, StorageLocations::FolderName),
                        ])
                        .from(StorageLocations::Table)
                        .and_where(Expr::col(StorageLocations::MergedAt).is_not_null())
                        .and_where(Expr::col(StorageLocations::PartsDeletedAt).is_null())
                        .and_where(no_active_reader_lease(Some(ReaderLeaseScope::Parts)))
                        .limit(PAGE_SIZE.into()),
                )
                .await?;
            let failures_before = failures.len();
            for location in &locations {
                let mut tx = db.pool.begin().await?;
                let claimed = claim_parts_deletion_if_unread(db, &mut tx, &location.id).await?;
                tx.commit().await?;
                if !claimed {
                    continue;
                }
                match self
                    .storage
                    .adapter
                    .delete_folder(&parts_folder(&location.folder_name))
                    .await
                {
                    Ok(deleted) => {
                        summary.deleted_parts =
                            summary.deleted_parts.saturating_add(deleted.objects);
                        summary.deleted_bytes = summary.deleted_bytes.saturating_add(deleted.bytes);
                    }
                    Err(failure) => {
                        db.execute(
                            &db.pool,
                            Query::update()
                                .table(StorageLocations::Table)
                                .value(StorageLocations::PartsDeletedAt, Option::<i64>::None)
                                .and_where(
                                    Expr::col(StorageLocations::Id).eq(location.id.as_str()),
                                ),
                        )
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
        let mut live_lease = Query::select();
        live_lease
            .column((MergeLeases::Table, MergeLeases::StorageLocationId))
            .from(MergeLeases::Table)
            .and_where(
                Expr::col((MergeLeases::Table, MergeLeases::StorageLocationId))
                    .equals((StorageLocations::Table, StorageLocations::Id)),
            )
            .and_where(Expr::col((MergeLeases::Table, MergeLeases::ExpiresAt)).gt(now));
        summary.updated = db
            .execute(
                &db.pool,
                Query::update()
                    .table(StorageLocations::Table)
                    .values([
                        (StorageLocations::MergeStartedAt, Option::<i64>::None.into()),
                        (StorageLocations::MergedAt, Option::<i64>::None.into()),
                    ])
                    .and_where(
                        Expr::col(StorageLocations::MergeStartedAt)
                            .lt(now.saturating_sub(15 * MINUTE_MS)),
                    )
                    .and_where(Expr::col(StorageLocations::MergedAt).is_null())
                    .and_where(Expr::exists(live_lease).not()),
            )
            .await?;
        db.execute(
            &db.pool,
            Query::delete()
                .from_table(MergeLeases::Table)
                .and_where(Expr::col(MergeLeases::ExpiresAt).lte(now)),
        )
        .await?;
        // Expired Storage Reader Leases are otherwise only removed by stream teardown or location
        // cascade; direct-download leases rely on this purge.
        db.execute(
            &db.pool,
            Query::delete()
                .from_table(StorageReaderLeases::Table)
                .and_where(Expr::col(StorageReaderLeases::ExpiresAt).lte(now)),
        )
        .await?;
        Ok(())
    }
}

#[derive(Debug, sqlx::FromRow)]
#[sqlx(rename_all = "camelCase")]
struct FolderNameRow {
    #[sqlx(try_from = "Utf8Text")]
    folder_name: String,
}

/// Deletes stored folders that no database record authorizes once they are older than the grace
/// period (ADR-0001), as of `now`.
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
    let locations: Vec<FolderNameRow> = db
        .all(
            &db.pool,
            Query::select()
                .column(StorageLocations::FolderName)
                .from(StorageLocations::Table),
        )
        .await?;
    let uploads: Vec<FolderNameRow> = db
        .all(
            &db.pool,
            Query::select()
                .column(Uploads::FolderName)
                .from(Uploads::Table),
        )
        .await?;
    let authorized: HashSet<String> = locations
        .into_iter()
        .chain(uploads)
        .map(|row| row.folder_name)
        .collect();
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

#[cfg(test)]
mod tests {
    use chrono::FixedOffset;

    use super::*;

    #[test]
    fn schedules_follow_local_wall_clock_time() {
        let berlin = FixedOffset::east_opt(2 * 3600).unwrap();
        let india = FixedOffset::east_opt(5 * 3600 + 30 * 60).unwrap();
        let at = |zone: FixedOffset, time: &str| {
            DateTime::parse_from_rfc3339(time)
                .unwrap()
                .with_timezone(&zone)
        };
        let noon = "2026-10-24T12:00:00Z";
        assert_eq!(
            next_run(&at(berlin, noon), 24 * 60),
            at(berlin, "2026-10-24T22:00:00Z"),
            "daily at local midnight"
        );
        assert_eq!(
            next_run(&at(india, noon), 60),
            at(india, "2026-10-24T12:30:00Z"),
            "hourly on the local hour"
        );
        assert_eq!(
            next_run(&at(berlin, "2026-10-24T12:05:00Z"), 5),
            at(berlin, "2026-10-24T12:10:00Z"),
            "a boundary moves on to the next one"
        );
    }

    #[test]
    fn schedules_pass_over_dst_changes_like_cron() {
        let berlin = |time: &str| {
            DateTime::parse_from_rfc3339(time)
                .unwrap()
                .with_timezone(&chrono_tz::Europe::Berlin)
        };
        // 02:00 local is skipped on 2026-03-29: the next run is 03:00 local.
        let before_gap = berlin("2026-03-29T00:59:58Z");
        assert_eq!(
            next_run(&before_gap, 5),
            berlin("2026-03-29T01:00:00Z"),
            "5 minutes"
        );
        assert_eq!(
            next_run(&before_gap, 60),
            berlin("2026-03-29T01:00:00Z"),
            "hourly"
        );
        // 02:00-03:00 local repeats on 2026-10-25: each run lies ahead.
        let repeated = berlin("2026-10-25T01:00:30Z");
        assert_eq!(
            next_run(&repeated, 5),
            berlin("2026-10-25T01:05:00Z"),
            "second pass"
        );
    }
}
