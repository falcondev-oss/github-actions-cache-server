//! Merge Leases and Storage Reader Leases (ADR-0002).

use std::time::Duration;

use sea_orm::ActiveValue::Set;
use sea_orm::{ConnectionTrait, EntityTrait as _, QueryFilter as _};

use crate::db::{
    Db, ReaderLeaseScope, is_unique_violation, merge_leases, now_ms, retry_on_lock_conflict,
    storage_reader_leases,
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
    let lease = merge_leases::ActiveModel {
        token: Set(token.clone()),
        expires_at: Set(deadline(LEASE_DURATION)),
        ..Default::default()
    };
    let taken_over = merge_leases::Entity::update_many()
        .set(lease.clone())
        .filter(
            merge_leases::COLUMN
                .storage_location_id
                .eq(storage_location_id),
        )
        .filter(merge_leases::COLUMN.expires_at.lte(now))
        .exec(&db.pool)
        .await?;
    if taken_over.rows_affected == 1 {
        return Ok(Some(token));
    }
    // A live lease of another worker makes the insert a unique violation. Detected here rather
    // than with `ON CONFLICT DO NOTHING`, which has no portable MySQL rendering.
    let lease = merge_leases::ActiveModel {
        storage_location_id: Set(storage_location_id.to_owned()),
        ..lease
    };
    match merge_leases::Entity::insert(lease)
        .exec_without_returning(&db.pool)
        .await
    {
        Ok(_) => Ok(Some(token)),
        Err(error) if is_unique_violation(&error) => Ok(None),
        Err(error) => Err(error.into()),
    }
}

pub(crate) async fn renew_merge_lease(
    db: &Db,
    storage_location_id: &str,
    token: &str,
) -> Result<bool> {
    let renewed = merge_leases::Entity::update_many()
        .set(merge_leases::ActiveModel {
            expires_at: Set(deadline(LEASE_DURATION)),
            ..Default::default()
        })
        .filter(
            merge_leases::COLUMN
                .storage_location_id
                .eq(storage_location_id),
        )
        .filter(merge_leases::COLUMN.token.eq(token))
        .filter(merge_leases::COLUMN.expires_at.gt(now_ms()))
        .exec(&db.pool)
        .await?;
    Ok(renewed.rows_affected == 1)
}

pub(crate) async fn release_merge_lease(
    db: &Db,
    storage_location_id: &str,
    token: &str,
) -> Result<()> {
    merge_leases::Entity::delete_many()
        .filter(
            merge_leases::COLUMN
                .storage_location_id
                .eq(storage_location_id),
        )
        .filter(merge_leases::COLUMN.token.eq(token))
        .exec(&db.pool)
        .await?;
    Ok(())
}

pub(crate) async fn create_reader_lease(
    db: &impl ConnectionTrait,
    storage_location_id: &str,
    scope: ReaderLeaseScope,
    expires_at: i64,
) -> Result<String> {
    let id = uuid::Uuid::new_v4().to_string();
    storage_reader_leases::Entity::insert(storage_reader_leases::ActiveModel {
        id: Set(id.clone()),
        storage_location_id: Set(storage_location_id.to_owned()),
        scope: Set(scope),
        expires_at: Set(expires_at),
    })
    .exec_without_returning(db)
    .await?;
    Ok(id)
}

pub(crate) async fn renew_reader_lease(db: &Db, id: &str) -> Result<bool> {
    let renewed = storage_reader_leases::Entity::update_many()
        .set(storage_reader_leases::ActiveModel {
            expires_at: Set(deadline(LEASE_DURATION)),
            ..Default::default()
        })
        .filter(storage_reader_leases::COLUMN.id.eq(id))
        .filter(storage_reader_leases::COLUMN.expires_at.gt(now_ms()))
        .exec(&db.pool)
        .await?;
    Ok(renewed.rows_affected == 1)
}

pub(crate) async fn release_reader_lease(db: &Db, id: &str) -> Result<()> {
    // races cascade deletes of the storage location, which lock rows in the opposite order
    retry_on_lock_conflict(|| async {
        Ok(storage_reader_leases::Entity::delete_by_id(id)
            .exec(&db.pool)
            .await?)
    })
    .await?;
    Ok(())
}
