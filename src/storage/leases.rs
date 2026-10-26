//! Merge Leases and Storage Reader Leases (ADR-0002).

use std::time::Duration;

use sea_query::{Expr, Query};
use sqlx::{Any, Executor};

use crate::db::{
    Db, MergeLeases, ReaderLeaseScope, StorageReaderLeases, is_unique_violation, now_ms,
    retry_on_lock_conflict,
};
use crate::error::Result;

pub(crate) const LEASE_DURATION: Duration = Duration::from_mins(2);
/// Renewal interval; short under test so lease loss is observable without waiting.
pub(crate) const LEASE_RENEWAL: Duration = if cfg!(test) {
    Duration::from_millis(100)
} else {
    Duration::from_secs(30)
};
/// Lifetime of a signed direct-download URL and the reader lease that protects it.
pub(crate) const DIRECT_DOWNLOAD_LEASE_DURATION: Duration = Duration::from_mins(10);

/// The timestamp column value `duration` from now.
pub(crate) fn deadline(duration: Duration) -> i64 {
    now_ms().saturating_add(i64::try_from(duration.as_millis()).unwrap_or(i64::MAX))
}

/// Claims the Merge of a storage location; `None` while another worker holds it.
pub(crate) async fn acquire_merge_lease(
    db: &Db,
    storage_location_id: &str,
) -> Result<Option<String>> {
    let now = now_ms();
    let token = uuid::Uuid::new_v4().to_string();
    let expires_at = deadline(LEASE_DURATION);
    let taken_over = db
        .execute(
            &db.pool,
            Query::update()
                .table(MergeLeases::Table)
                .values([
                    (MergeLeases::Token, token.as_str().into()),
                    (MergeLeases::ExpiresAt, expires_at.into()),
                ])
                .and_where(Expr::col(MergeLeases::StorageLocationId).eq(storage_location_id))
                .and_where(Expr::col(MergeLeases::ExpiresAt).lte(now)),
        )
        .await?;
    if taken_over == 1 {
        return Ok(Some(token));
    }
    let mut insert = Query::insert();
    insert
        .into_table(MergeLeases::Table)
        .columns([
            MergeLeases::StorageLocationId,
            MergeLeases::Token,
            MergeLeases::ExpiresAt,
        ])
        .values([
            storage_location_id.into(),
            token.as_str().into(),
            expires_at.into(),
        ])?;
    // A live lease of another worker makes the insert a unique violation. Detected here rather
    // than with `ON CONFLICT DO NOTHING`, which has no portable MySQL rendering.
    match db.execute(&db.pool, &insert).await {
        Ok(_) => Ok(Some(token)),
        Err(failure) if is_unique_violation(&failure) => Ok(None),
        Err(failure) => Err(failure),
    }
}

pub(crate) async fn renew_merge_lease(
    db: &Db,
    storage_location_id: &str,
    token: &str,
) -> Result<bool> {
    let now = now_ms();
    let renewed = db
        .execute(
            &db.pool,
            Query::update()
                .table(MergeLeases::Table)
                .value(MergeLeases::ExpiresAt, deadline(LEASE_DURATION))
                .and_where(Expr::col(MergeLeases::StorageLocationId).eq(storage_location_id))
                .and_where(Expr::col(MergeLeases::Token).eq(token))
                .and_where(Expr::col(MergeLeases::ExpiresAt).gt(now)),
        )
        .await?;
    Ok(renewed == 1)
}

pub(crate) async fn release_merge_lease(
    db: &Db,
    storage_location_id: &str,
    token: &str,
) -> Result<()> {
    db.execute(
        &db.pool,
        Query::delete()
            .from_table(MergeLeases::Table)
            .and_where(Expr::col(MergeLeases::StorageLocationId).eq(storage_location_id))
            .and_where(Expr::col(MergeLeases::Token).eq(token)),
    )
    .await?;
    Ok(())
}

pub(crate) async fn create_reader_lease<'c>(
    db: &Db,
    executor: impl Executor<'c, Database = Any>,
    storage_location_id: &str,
    scope: ReaderLeaseScope,
    expires_at: i64,
) -> Result<String> {
    let id = uuid::Uuid::new_v4().to_string();
    let mut insert = Query::insert();
    insert
        .into_table(StorageReaderLeases::Table)
        .columns([
            StorageReaderLeases::Id,
            StorageReaderLeases::StorageLocationId,
            StorageReaderLeases::Scope,
            StorageReaderLeases::ExpiresAt,
        ])
        .values([
            id.as_str().into(),
            storage_location_id.into(),
            scope.as_str().into(),
            expires_at.into(),
        ])?;
    db.execute(executor, &insert).await?;
    Ok(id)
}

pub(crate) async fn renew_reader_lease(db: &Db, id: &str) -> Result<bool> {
    let now = now_ms();
    let renewed = db
        .execute(
            &db.pool,
            Query::update()
                .table(StorageReaderLeases::Table)
                .value(StorageReaderLeases::ExpiresAt, deadline(LEASE_DURATION))
                .and_where(Expr::col(StorageReaderLeases::Id).eq(id))
                .and_where(Expr::col(StorageReaderLeases::ExpiresAt).gt(now)),
        )
        .await?;
    Ok(renewed == 1)
}

pub(crate) async fn release_reader_lease(db: &Db, id: &str) -> Result<()> {
    // races cascade deletes of the storage location, which lock rows in the opposite order
    retry_on_lock_conflict(|| async {
        db.execute(
            &db.pool,
            Query::delete()
                .from_table(StorageReaderLeases::Table)
                .and_where(Expr::col(StorageReaderLeases::Id).eq(id)),
        )
        .await
    })
    .await?;
    Ok(())
}
