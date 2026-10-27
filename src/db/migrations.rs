//! Schema migrations, applied on startup by `sea-orm-migration`.
//!
//! A database last migrated by v9 carries Kysely's bookkeeping instead. At v9.10's schema, which
//! the baseline reproduces, it is adopted with its data. An older one holds nothing a cache can't
//! rebuild, so it is dropped and recreated, and storage is cleared with it.

mod baseline;

use sea_orm::ActiveValue::Set;
use sea_orm::sea_query::{Order, Query, Table};
use sea_orm::{ConnectionTrait as _, DatabaseTransaction, EntityTrait as _, TransactionTrait as _};
use sea_orm_migration::{
    MigrationName as _, MigrationTrait, MigratorTrait, SchemaManager, seaql_migrations,
};

use super::{Db, Dialect};
use crate::error::Result;

struct Migrator;

impl MigratorTrait for Migrator {
    fn migrations() -> Vec<Box<dyn MigrationTrait>> {
        vec![Box::new(baseline::Migration)]
    }
}

/// Serializes migrations of replicas starting at once.
const POSTGRES_LOCK_ID: i64 = 3_853_314_791_062_309_107;
const MYSQL_LOCK_NAME: &str = "github-actions-cache-server-migrations";

/// Every migration v9.10 recorded, in order.
const V9_MIGRATIONS: [&str; 9] = [
    "$0_init",
    "$1_upload_part_counts",
    "$2_scopes",
    "$3_repoId",
    "$4_storage_leases",
    "$5_storage_location_sizes",
    "$6_cache_entries_locationId_index",
    "$7_uploads_reservationHash",
    "$8_exact_key_scope_collation",
];

/// Children before the table they reference.
const DATA_TABLES: [&str; 5] = [
    "cache_entries",
    "merge_leases",
    "storage_reader_leases",
    "uploads",
    "storage_locations",
];
const KYSELY_TABLES: [&str; 2] = ["kysely_migration", "kysely_migration_lock"];

/// Migrates to the latest schema; true when storage must be cleared.
pub(super) async fn migrate(db: &Db) -> Result<bool> {
    tracing::info!("migrating database");
    // The transaction pins the connection holding the lock. MySQL commits DDL implicitly, so
    // there it doesn't make the run atomic.
    let tx = db.pool.begin().await?;
    let (lock, unlock) = match db.dialect {
        Dialect::Postgres => (
            Some(format!("select pg_advisory_xact_lock({POSTGRES_LOCK_ID})")),
            None,
        ),
        Dialect::Mysql => (
            Some(format!("select get_lock('{MYSQL_LOCK_NAME}', 3600)")),
            Some(format!("select release_lock('{MYSQL_LOCK_NAME}')")),
        ),
        Dialect::Sqlite => (None, None),
    };
    if let Some(lock) = lock {
        tx.execute_unprepared(&lock).await?;
    }
    let migrated = async {
        let clears_storage = take_over_v9(&tx).await?;
        Migrator::up(&tx, None).await?;
        Ok::<_, crate::error::Failure>(clears_storage)
    }
    .await;
    if let Some(unlock) = unlock {
        tx.execute_unprepared(&unlock).await?;
    }
    let clears_storage = migrated?;
    tx.commit().await?;
    tracing::info!("database migrated");
    Ok(clears_storage)
}

/// Replaces Kysely's bookkeeping, adopting a v9.10 database or dropping an older one; true when it
/// was dropped.
async fn take_over_v9(tx: &DatabaseTransaction) -> Result<bool> {
    let manager = SchemaManager::new(tx);
    if !manager.has_table("kysely_migration").await? {
        return Ok(false);
    }
    let applied: Vec<String> = tx
        .query_all(
            Query::select()
                .column("name")
                .from("kysely_migration")
                .order_by("name", Order::Asc),
        )
        .await?
        .iter()
        .map(|row| row.try_get("", "name"))
        .collect::<Result<_, _>>()?;
    let adopt = applied == V9_MIGRATIONS;
    let dropped: &[&str] = if adopt {
        tracing::info!("adopting v9 database");
        Migrator::install(tx).await?;
        seaql_migrations::Entity::insert(seaql_migrations::ActiveModel {
            version: Set(baseline::Migration.name().to_owned()),
            applied_at: Set(chrono::Utc::now().timestamp()),
        })
        .exec_without_returning(tx)
        .await?;
        &[]
    } else {
        tracing::warn!(
            migrations = applied.len(),
            "dropping database older than v9.10 and clearing storage"
        );
        &DATA_TABLES
    };
    for &table in dropped.iter().chain(&KYSELY_TABLES) {
        manager
            .drop_table(Table::drop().table(table).if_exists().take())
            .await?;
    }
    Ok(!adopt)
}

#[cfg(test)]
mod tests;
