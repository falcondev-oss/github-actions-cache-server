//! Deletion guards shared by cleanup, eviction and self-healing (ADR-0001, ADR-0002).

use sea_query::{Expr, LockType, Query, SimpleExpr};
use sqlx::AnyConnection;

use crate::db::{Db, IdRow, ReaderLeaseScope, StorageLocations, StorageReaderLeases, now_ms};
use crate::error::Result;

/// True when no unexpired Storage Reader Lease (optionally scoped) protects the
/// `storage_locations` row of the enclosing query.
pub(crate) fn no_active_reader_lease(scope: Option<ReaderLeaseScope>) -> SimpleExpr {
    let mut leases = Query::select();
    leases
        .column((StorageReaderLeases::Table, StorageReaderLeases::Id))
        .from(StorageReaderLeases::Table)
        .and_where(
            Expr::col((
                StorageReaderLeases::Table,
                StorageReaderLeases::StorageLocationId,
            ))
            .equals((StorageLocations::Table, StorageLocations::Id)),
        )
        .and_where(
            Expr::col((StorageReaderLeases::Table, StorageReaderLeases::ExpiresAt)).gt(now_ms()),
        );
    if let Some(scope) = scope {
        leases.and_where(
            Expr::col((StorageReaderLeases::Table, StorageReaderLeases::Scope)).eq(scope.as_str()),
        );
    }
    Expr::exists(leases).not()
}

async fn lock_storage_location(db: &Db, tx: &mut AnyConnection, id: &str) -> Result<bool> {
    let row: Option<IdRow> = db
        .optional(
            tx,
            Query::select()
                .column(StorageLocations::Id)
                .from(StorageLocations::Table)
                .and_where(Expr::col(StorageLocations::Id).eq(id))
                .lock(LockType::Update),
        )
        .await?;
    Ok(row.is_some())
}

async fn has_active_reader_lease(
    db: &Db,
    tx: &mut AnyConnection,
    storage_location_id: &str,
    scope: Option<ReaderLeaseScope>,
) -> Result<bool> {
    let mut query = Query::select();
    query
        .column(StorageReaderLeases::Id)
        .from(StorageReaderLeases::Table)
        .and_where(Expr::col(StorageReaderLeases::StorageLocationId).eq(storage_location_id))
        .and_where(Expr::col(StorageReaderLeases::ExpiresAt).gt(now_ms()));
    if let Some(scope) = scope {
        query.and_where(Expr::col(StorageReaderLeases::Scope).eq(scope.as_str()));
    }
    let lease: Option<IdRow> = db.optional(tx, &query.limit(1).to_owned()).await?;
    Ok(lease.is_some())
}

/// Deletes the storage location row unless a reader is active. Run inside a transaction.
pub(crate) async fn delete_storage_location_if_unread(
    db: &Db,
    tx: &mut AnyConnection,
    storage_location_id: &str,
) -> Result<LocationDeletion> {
    if !lock_storage_location(db, tx, storage_location_id).await? {
        return Ok(LocationDeletion::Missing);
    }
    if has_active_reader_lease(db, tx, storage_location_id, None).await? {
        return Ok(LocationDeletion::InUse);
    }
    db.execute(
        tx,
        Query::delete()
            .from_table(StorageLocations::Table)
            .and_where(Expr::col(StorageLocations::Id).eq(storage_location_id)),
    )
    .await?;
    Ok(LocationDeletion::Deleted)
}

/// Outcome of deleting a storage location.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum LocationDeletion {
    Deleted,
    /// Already gone, e.g. deleted concurrently.
    Missing,
    /// A Storage Reader Lease protects it (ADR-0002).
    InUse,
}

/// Marks the location's Parts as deleted unless a Part Reader Lease is active. Run inside a
/// transaction.
pub(crate) async fn claim_parts_deletion_if_unread(
    db: &Db,
    tx: &mut AnyConnection,
    storage_location_id: &str,
) -> Result<bool> {
    if !lock_storage_location(db, tx, storage_location_id).await?
        || has_active_reader_lease(db, tx, storage_location_id, Some(ReaderLeaseScope::Parts))
            .await?
    {
        return Ok(false);
    }
    let claimed = db
        .execute(
            tx,
            Query::update()
                .table(StorageLocations::Table)
                .value(StorageLocations::PartsDeletedAt, now_ms())
                .and_where(Expr::col(StorageLocations::Id).eq(storage_location_id))
                .and_where(Expr::col(StorageLocations::PartsDeletedAt).is_null()),
        )
        .await?;
    Ok(claimed == 1)
}
