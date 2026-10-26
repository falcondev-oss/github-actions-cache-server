//! Deletion guards shared by cleanup, eviction and self-healing (ADR-0001, ADR-0002).

use sea_orm::ActiveValue::Set;
use sea_orm::sea_query::{Expr, ExprTrait as _};
use sea_orm::{
    ColumnTrait as _, ConnectionTrait, EntityTrait as _, QueryFilter as _, QuerySelect as _,
    QueryTrait as _, SelectExt as _,
};

use crate::db::{ReaderLeaseScope, now_ms, storage_locations, storage_reader_leases};
use crate::error::Result;

/// Unexpired Storage Reader Leases, optionally of one scope.
fn active_reader_leases(
    scope: Option<ReaderLeaseScope>,
) -> sea_orm::Select<storage_reader_leases::Entity> {
    storage_reader_leases::Entity::find()
        .filter(storage_reader_leases::COLUMN.expires_at.gt(now_ms()))
        .apply_if(scope, |leases, scope| {
            leases.filter(storage_reader_leases::COLUMN.scope.eq(scope))
        })
}

/// True when no unexpired Storage Reader Lease (optionally scoped) protects the
/// `storage_locations` row of the enclosing query.
pub(crate) fn no_active_reader_lease(scope: Option<ReaderLeaseScope>) -> Expr {
    let leases = active_reader_leases(scope)
        .select_only()
        .column(storage_reader_leases::Column::Id)
        .filter(
            storage_reader_leases::Column::StorageLocationId
                .into_expr()
                .equals((storage_locations::Entity, storage_locations::Column::Id)),
        )
        .into_query();
    Expr::exists(leases).not()
}

async fn lock_storage_location(db: &impl ConnectionTrait, id: &str) -> Result<bool> {
    Ok(storage_locations::Entity::find_by_id(id)
        .lock_exclusive()
        .one(db)
        .await?
        .is_some())
}

async fn has_active_reader_lease(
    db: &impl ConnectionTrait,
    storage_location_id: &str,
    scope: Option<ReaderLeaseScope>,
) -> Result<bool> {
    Ok(active_reader_leases(scope)
        .filter(
            storage_reader_leases::COLUMN
                .storage_location_id
                .eq(storage_location_id),
        )
        .exists(db)
        .await?)
}

/// Deletes the storage location row unless a reader is active. Run inside a transaction.
pub(crate) async fn delete_storage_location_if_unread(
    tx: &impl ConnectionTrait,
    storage_location_id: &str,
) -> Result<LocationDeletion> {
    if !lock_storage_location(tx, storage_location_id).await? {
        return Ok(LocationDeletion::Missing);
    }
    if has_active_reader_lease(tx, storage_location_id, None).await? {
        return Ok(LocationDeletion::InUse);
    }
    storage_locations::Entity::delete_by_id(storage_location_id)
        .exec(tx)
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
    tx: &impl ConnectionTrait,
    storage_location_id: &str,
) -> Result<bool> {
    if !lock_storage_location(tx, storage_location_id).await?
        || has_active_reader_lease(tx, storage_location_id, Some(ReaderLeaseScope::Parts)).await?
    {
        return Ok(false);
    }
    let claimed = storage_locations::Entity::update_many()
        .set(storage_locations::ActiveModel {
            parts_deleted_at: Set(Some(now_ms())),
            ..Default::default()
        })
        .filter(storage_locations::COLUMN.id.eq(storage_location_id))
        .filter(storage_locations::COLUMN.parts_deleted_at.is_null())
        .exec(tx)
        .await?;
    Ok(claimed.rows_affected == 1)
}
