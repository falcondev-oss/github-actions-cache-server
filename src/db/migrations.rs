//! Schema migrations.
//!
//! The schema and its bookkeeping tables (`kysely_migration`, `kysely_migration_lock`) are the
//! ones the original TypeScript server created with Kysely, so existing databases upgrade in
//! place and both implementations can share a database during a rolling deployment.

use std::collections::HashSet;

use futures_util::FutureExt as _;
use futures_util::future::BoxFuture;
use sea_orm::ActiveValue::Set;
use sea_orm::{
    ConnectionTrait, DatabaseTransaction, EntityTrait as _, QueryFilter as _, QueryOrder as _,
    QuerySelect as _, Statement, TransactionTrait as _,
};

use super::{Db, Dialect, EntryIdentity, uploads};
use crate::error::{Failure, Result};

/// Kysely's advisory lock id for Postgres.
const POSTGRES_LOCK_ID: i64 = 3_853_314_791_062_309_107;
/// Kysely's named lock for MySQL.
const MYSQL_LOCK_ID: &str = "ea586330-2c93-47c8-908d-981d9d270f9d";

struct Ddl(Dialect);

impl Ddl {
    fn q(&self, ident: &str) -> String {
        match self.0 {
            Dialect::Mysql => format!("`{ident}`"),
            Dialect::Postgres | Dialect::Sqlite => format!("\"{ident}\""),
        }
    }

    /// MySQL cannot index or key unbounded `text`.
    fn text(&self, mysql_length: u16) -> String {
        match self.0 {
            Dialect::Mysql => format!("varchar({mysql_length})"),
            Dialect::Postgres | Dialect::Sqlite => "text".to_owned(),
        }
    }

    fn id(&self) -> String {
        self.text(36)
    }

    fn index(&self, name: &str, table: &str, columns: &[&str]) -> String {
        let columns = columns
            .iter()
            .map(|column| self.q(column))
            .collect::<Vec<_>>()
            .join(", ");
        format!(
            "create index {} on {} ({columns})",
            self.q(name),
            self.q(table)
        )
    }

    fn add_column(&self, table: &str, column: &str, definition: &str) -> String {
        format!(
            "alter table {} add column {} {definition}",
            self.q(table),
            self.q(column)
        )
    }

    fn references_locations(&self) -> String {
        format!(
            "references {} ({}) on delete cascade",
            self.q("storage_locations"),
            self.q("id")
        )
    }

    fn delete_all(&self) -> Vec<String> {
        ["cache_entries", "storage_locations", "uploads"]
            .iter()
            .map(|table| format!("delete from {}", self.q(table)))
            .collect()
    }
}

/// Work a migration does after its statements, with the migration's connection.
type PostStep = for<'c> fn(&'c DatabaseTransaction, &'c Ddl) -> BoxFuture<'c, Result<()>>;

struct Migration {
    name: &'static str,
    /// The migration invalidates all stored cache data, so storage is cleared once it is ready.
    clears_storage: bool,
    statements: fn(&Ddl) -> Vec<String>,
    after: Option<PostStep>,
}

const fn step(name: &'static str, statements: fn(&Ddl) -> Vec<String>) -> Migration {
    Migration {
        name,
        clears_storage: false,
        statements,
        after: None,
    }
}

const MIGRATIONS: [Migration; 9] = [
    step("$0_init", init),
    step("$1_upload_part_counts", part_counts),
    step("$2_scopes", scopes),
    Migration {
        clears_storage: true,
        ..step("$3_repoId", repo_id)
    },
    step("$4_storage_leases", storage_leases),
    step("$5_storage_location_sizes", sizes),
    step("$6_cache_entries_locationId_index", location_index),
    Migration {
        after: Some(|tx, d| backfill_reservation_hashes(tx, d).boxed()),
        ..step("$7_uploads_reservationHash", reservation_hash)
    },
    step("$8_exact_key_scope_collation", exact_collation),
];

fn init(d: &Ddl) -> Vec<String> {
    let (id, q) = (d.id(), |ident| d.q(ident));
    vec![
        format!(
            "create table {} ({} {id} primary key, {} text not null, {} integer not null, {} \
             bigint, {} bigint, {} bigint, {} bigint)",
            q("storage_locations"),
            q("id"),
            q("folderName"),
            q("partCount"),
            q("mergeStartedAt"),
            q("mergedAt"),
            q("partsDeletedAt"),
            q("lastDownloadedAt"),
        ),
        format!(
            "create table {} ({} {id} primary key, {} {} not null, {} {} not null, {} bigint not \
             null, {} {id} not null {})",
            q("cache_entries"),
            q("id"),
            q("key"),
            d.text(512),
            q("version"),
            d.text(255),
            q("updatedAt"),
            q("locationId"),
            d.references_locations(),
        ),
        format!(
            "create table {} ({} bigint primary key, {} {} not null, {} {} not null, {} bigint not \
             null, {} bigint, {} text not null)",
            q("uploads"),
            q("id"),
            q("key"),
            d.text(512),
            q("version"),
            d.text(255),
            q("createdAt"),
            q("lastPartUploadedAt"),
            q("folderName"),
        ),
        d.index(
            "idx_cache_entries_key_version",
            "cache_entries",
            &["key", "version"],
        ),
        d.index("idx_uploads_key_version", "uploads", &["key", "version"]),
    ]
}

fn part_counts(d: &Ddl) -> Vec<String> {
    vec![
        d.add_column(
            "uploads",
            "finishedPartUploadCount",
            "integer default 0 not null",
        ),
        d.add_column(
            "uploads",
            "startedPartUploadCount",
            "integer default 0 not null",
        ),
    ]
}

fn scoped_column(d: &Ddl, column: &str) -> Vec<String> {
    let definition = format!("{} not null", d.text(255));
    let mut statements = d.delete_all();
    statements.extend([
        d.add_column("cache_entries", column, &definition),
        d.index(
            &format!("idx_cache_entries_{column}"),
            "cache_entries",
            &[column],
        ),
        d.add_column("uploads", column, &definition),
        d.index(&format!("idx_uploads_{column}"), "uploads", &[column]),
    ]);
    statements
}

fn scopes(d: &Ddl) -> Vec<String> {
    scoped_column(d, "scope")
}

fn repo_id(d: &Ddl) -> Vec<String> {
    scoped_column(d, "repoId")
}

fn storage_leases(d: &Ddl) -> Vec<String> {
    let (id, q) = (d.id(), |ident| d.q(ident));
    vec![
        format!(
            "create table {} ({} {id} primary key {}, {} {id} not null, {} bigint not null)",
            q("merge_leases"),
            q("storageLocationId"),
            d.references_locations(),
            q("token"),
            q("expiresAt"),
        ),
        format!(
            "create table {} ({} {id} primary key, {} {id} not null {}, {} {} not null, {} bigint \
             not null)",
            q("storage_reader_leases"),
            q("id"),
            q("storageLocationId"),
            d.references_locations(),
            q("scope"),
            d.text(16),
            q("expiresAt"),
        ),
        d.index(
            "idx_storage_reader_leases_location_expiry",
            "storage_reader_leases",
            &["storageLocationId", "expiresAt"],
        ),
    ]
}

fn sizes(d: &Ddl) -> Vec<String> {
    vec![d.add_column("storage_locations", "sizeBytes", "bigint")]
}

fn reservation_hash(d: &Ddl) -> Vec<String> {
    // A unique index over (key, version, scope, repoId) exceeds MySQL's 3072-byte key limit, so
    // it covers a fixed-width hash of the tuple. Nullable so replicas still on the previous
    // version can insert during a rollout.
    vec![d.add_column("uploads", "reservationHash", "char(64)")]
}

/// MySQL's default collation ignores case, accents and trailing spaces; GitHub compares exactly.
fn exact_collation(d: &Ddl) -> Vec<String> {
    if d.0 != Dialect::Mysql {
        return Vec::new();
    }
    ["cache_entries", "uploads"]
        .iter()
        .map(|table| {
            format!(
                "alter table {} modify column {} varchar(512) collate utf8mb4_0900_bin not null, \
                 modify column {} varchar(255) collate utf8mb4_0900_bin not null",
                d.q(table),
                d.q("key"),
                d.q("scope"),
            )
        })
        .collect()
}

async fn backfill_reservation_hashes(tx: &DatabaseTransaction, d: &Ddl) -> Result<()> {
    let uploads: Vec<(i64, String, String, String, String)> = uploads::Entity::find()
        .select_only()
        .columns([
            uploads::Column::Id,
            uploads::Column::Key,
            uploads::Column::Version,
            uploads::Column::Scope,
            uploads::Column::RepoId,
        ])
        .order_by_desc(uploads::COLUMN.created_at)
        .into_tuple()
        .all(tx)
        .await?;
    let mut seen = HashSet::new();
    for (id, key, version, scope, repo_id) in uploads {
        let hash = EntryIdentity {
            key,
            version,
            scope,
            repo_id,
        }
        .reservation_hash();
        // Older uploads of a reservation are dropped; orphaned storage cleanup reclaims their
        // parts.
        if seen.insert(hash.clone()) {
            uploads::Entity::update_many()
                .set(uploads::ActiveModel {
                    reservation_hash: Set(Some(hash)),
                    ..Default::default()
                })
                .filter(uploads::COLUMN.id.eq(id))
                .exec(tx)
                .await?;
        } else {
            uploads::Entity::delete_by_id(id).exec(tx).await?;
        }
    }
    tx.execute_unprepared(&format!(
        "create unique index {} on {} ({})",
        d.q("idx_uploads_reservationHash"),
        d.q("uploads"),
        d.q("reservationHash"),
    ))
    .await?;
    Ok(())
}

fn location_index(d: &Ddl) -> Vec<String> {
    vec![d.index(
        "idx_cache_entries_locationId",
        "cache_entries",
        &["locationId"],
    )]
}

/// Migrates to the latest schema; true when a migration requires clearing storage.
pub(super) async fn migrate(db: &Db) -> Result<bool> {
    migrate_through(db, MIGRATIONS.len()).await
}

/// Applies the first `count` migrations.
async fn migrate_through(db: &Db, count: usize) -> Result<bool> {
    tracing::info!("migrating database");
    // The transaction pins the connection holding the lock. MySQL commits DDL implicitly, so
    // there it doesn't make the run atomic.
    let tx = db.pool.begin().await?;
    let migrated = match db.dialect {
        Dialect::Postgres => {
            tx.execute_unprepared(&format!("select pg_advisory_xact_lock({POSTGRES_LOCK_ID})"))
                .await?;
            run(&tx, db.dialect, count).await?
        }
        Dialect::Mysql => {
            tx.execute_unprepared(&format!("select get_lock('{MYSQL_LOCK_ID}', 3600)"))
                .await?;
            let result = run(&tx, db.dialect, count).await;
            tx.execute_unprepared(&format!("select release_lock('{MYSQL_LOCK_ID}')"))
                .await?;
            result?
        }
        Dialect::Sqlite => run(&tx, db.dialect, count).await?,
    };
    tx.commit().await?;
    tracing::info!("database migrated");
    Ok(migrated)
}

/// The first column of every row `sql` returns.
async fn strings(tx: &impl ConnectionTrait, sql: String) -> Result<Vec<String>> {
    let backend = tx.get_database_backend();
    tx.query_all_raw(Statement::from_string(backend, sql))
        .await?
        .iter()
        .map(|row| Ok(row.try_get_by_index(0)?))
        .collect()
}

async fn run(tx: &DatabaseTransaction, dialect: Dialect, count: usize) -> Result<bool> {
    let d = Ddl(dialect);
    let q = |ident| d.q(ident);
    tx.execute_unprepared(&format!(
        "create table if not exists {} ({} varchar(255) not null primary key, {} varchar(255) \
         not null)",
        q("kysely_migration"),
        q("name"),
        q("timestamp"),
    ))
    .await?;
    tx.execute_unprepared(&format!(
        "create table if not exists {} ({} varchar(255) not null primary key, {} integer default \
         0 not null)",
        q("kysely_migration_lock"),
        q("id"),
        q("is_locked"),
    ))
    .await?;
    let lock_row = strings(
        tx,
        format!(
            "select {} from {} where {} = 'migration_lock'",
            q("id"),
            q("kysely_migration_lock"),
            q("id"),
        ),
    )
    .await?;
    if lock_row.is_empty() {
        tx.execute_unprepared(&format!(
            "insert into {} ({}, {}) values ('migration_lock', 0)",
            q("kysely_migration_lock"),
            q("id"),
            q("is_locked"),
        ))
        .await?;
    }

    let executed = strings(
        tx,
        format!(
            "select {} from {} order by {}",
            q("name"),
            q("kysely_migration"),
            q("name"),
        ),
    )
    .await?;

    for (index, name) in executed.iter().enumerate() {
        if MIGRATIONS
            .get(index)
            .is_none_or(|migration| migration.name != name)
        {
            return Err(Failure::msg(format!(
                "corrupted migrations: previously executed migration {name} is unknown to this \
                 version or out of order"
            )));
        }
    }

    let mut requires_storage_clear = false;
    for migration in MIGRATIONS.iter().take(count).skip(executed.len()) {
        tracing::info!(migration = migration.name, "applying migration");
        for statement in (migration.statements)(&d) {
            tx.execute_unprepared(&statement).await?;
        }
        if let Some(after) = migration.after {
            after(tx, &d).await?;
        }
        tx.execute_unprepared(&format!(
            "insert into {} ({}, {}) values ('{}', '{}')",
            q("kysely_migration"),
            q("name"),
            q("timestamp"),
            migration.name,
            chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        ))
        .await?;
        requires_storage_clear |= migration.clears_storage;
    }
    Ok(requires_storage_clear)
}

#[cfg(test)]
mod tests;
