//! Schema migrations.
//!
//! The schema and its bookkeeping tables (`kysely_migration`, `kysely_migration_lock`) are the
//! ones the original TypeScript server created with Kysely, so existing databases upgrade in
//! place and both implementations can share a database during a rolling deployment.

use std::collections::HashSet;

use futures_util::FutureExt as _;
use futures_util::future::BoxFuture;
use sea_query::{Expr, Order, Query};
use sea_query_binder::SqlxBinder as _;
use sqlx::{Acquire as _, AnyConnection, FromRow, Row as _};

use super::{Db, Dialect, EntryIdentity, Uploads};
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
type PostStep = for<'c> fn(&'c mut AnyConnection, &'c Ddl) -> BoxFuture<'c, Result<()>>;

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
        after: Some(|connection, d| backfill_reservation_hashes(connection, d).boxed()),
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

#[derive(FromRow)]
#[sqlx(rename_all = "camelCase")]
struct ReservationRow {
    id: i64,
    key: String,
    version: String,
    scope: String,
    repo_id: String,
}

async fn backfill_reservation_hashes(connection: &mut AnyConnection, d: &Ddl) -> Result<()> {
    let (sql, values) = Query::select()
        .columns([
            Uploads::Id,
            Uploads::Key,
            Uploads::Version,
            Uploads::Scope,
            Uploads::RepoId,
        ])
        .from(Uploads::Table)
        .order_by(Uploads::CreatedAt, Order::Desc)
        .build_any_sqlx(d.0.builder());
    let uploads: Vec<ReservationRow> = sqlx::query_as_with(&sql, values)
        .fetch_all(&mut *connection)
        .await?;
    let mut seen = HashSet::new();
    for upload in uploads {
        let hash = EntryIdentity {
            key: upload.key,
            version: upload.version,
            scope: upload.scope,
            repo_id: upload.repo_id,
        }
        .reservation_hash();
        // Older uploads of a reservation are dropped; orphaned storage cleanup reclaims their
        // parts.
        let (statement, arguments) = if seen.insert(hash.clone()) {
            Query::update()
                .table(Uploads::Table)
                .value(Uploads::ReservationHash, hash)
                .and_where(Expr::col(Uploads::Id).eq(upload.id))
                .build_any_sqlx(d.0.builder())
        } else {
            Query::delete()
                .from_table(Uploads::Table)
                .and_where(Expr::col(Uploads::Id).eq(upload.id))
                .build_any_sqlx(d.0.builder())
        };
        sqlx::query_with(&statement, arguments)
            .execute(&mut *connection)
            .await?;
    }
    sqlx::query(&format!(
        "create unique index {} on {} ({})",
        d.q("idx_uploads_reservationHash"),
        d.q("uploads"),
        d.q("reservationHash"),
    ))
    .execute(&mut *connection)
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
    let mut connection = db.pool.acquire().await?;
    let migrated = match db.dialect {
        Dialect::Postgres => {
            sqlx::query(&format!("select pg_advisory_lock({POSTGRES_LOCK_ID})"))
                .execute(&mut *connection)
                .await?;
            let result = migrate_in_transaction(&mut connection, db.dialect, count).await;
            sqlx::query(&format!("select pg_advisory_unlock({POSTGRES_LOCK_ID})"))
                .execute(&mut *connection)
                .await?;
            result?
        }
        // MySQL commits DDL implicitly, so a transaction would not make the run atomic.
        Dialect::Mysql => {
            sqlx::query(&format!("select get_lock('{MYSQL_LOCK_ID}', 3600)"))
                .execute(&mut *connection)
                .await?;
            let result = run(&mut connection, db.dialect, count).await;
            sqlx::query(&format!("select release_lock('{MYSQL_LOCK_ID}')"))
                .execute(&mut *connection)
                .await?;
            result?
        }
        Dialect::Sqlite => migrate_in_transaction(&mut connection, db.dialect, count).await?,
    };
    tracing::info!("database migrated");
    Ok(migrated)
}

async fn migrate_in_transaction(
    connection: &mut AnyConnection,
    dialect: Dialect,
    count: usize,
) -> Result<bool> {
    let mut transaction = connection.begin().await?;
    let migrated = run(&mut transaction, dialect, count).await?;
    transaction.commit().await?;
    Ok(migrated)
}

async fn run(connection: &mut AnyConnection, dialect: Dialect, count: usize) -> Result<bool> {
    let d = Ddl(dialect);
    let q = |ident| d.q(ident);
    sqlx::query(&format!(
        "create table if not exists {} ({} varchar(255) not null primary key, {} varchar(255) \
         not null)",
        q("kysely_migration"),
        q("name"),
        q("timestamp"),
    ))
    .execute(&mut *connection)
    .await?;
    sqlx::query(&format!(
        "create table if not exists {} ({} varchar(255) not null primary key, {} integer default \
         0 not null)",
        q("kysely_migration_lock"),
        q("id"),
        q("is_locked"),
    ))
    .execute(&mut *connection)
    .await?;
    let lock_row = sqlx::query(&format!(
        "select {} from {} where {} = 'migration_lock'",
        q("id"),
        q("kysely_migration_lock"),
        q("id"),
    ))
    .fetch_optional(&mut *connection)
    .await?;
    if lock_row.is_none() {
        sqlx::query(&format!(
            "insert into {} ({}, {}) values ('migration_lock', 0)",
            q("kysely_migration_lock"),
            q("id"),
            q("is_locked"),
        ))
        .execute(&mut *connection)
        .await?;
    }

    let executed = sqlx::query(&format!(
        "select {} from {} order by {}",
        q("name"),
        q("kysely_migration"),
        q("name"),
    ))
    .fetch_all(&mut *connection)
    .await?
    .iter()
    .map(|row| row.try_get::<String, _>(0))
    .collect::<Result<Vec<_>, _>>()?;

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
            sqlx::query(&statement).execute(&mut *connection).await?;
        }
        if let Some(after) = migration.after {
            after(connection, &d).await?;
        }
        sqlx::query(&format!(
            "insert into {} ({}, {}) values ('{}', '{}')",
            q("kysely_migration"),
            q("name"),
            q("timestamp"),
            migration.name,
            chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        ))
        .execute(&mut *connection)
        .await?;
        requires_storage_clear |= migration.clears_storage;
    }
    Ok(requires_storage_clear)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;
    use crate::db::{CacheEntry, select_entries};
    use crate::tests::harness::{self, entry, identity, unmerged_location};

    #[derive(Debug, PartialEq, Eq, FromRow)]
    struct UploadId {
        id: i64,
    }

    async fn insert_legacy_upload(db: &Db, id: i64, key: &str, created_at: i64) {
        let identity = identity(key);
        let mut insert = Query::insert();
        insert
            .into_table(Uploads::Table)
            .columns([
                Uploads::Id,
                Uploads::Key,
                Uploads::Version,
                Uploads::Scope,
                Uploads::RepoId,
                Uploads::CreatedAt,
                Uploads::FolderName,
            ])
            .values([
                id.into(),
                identity.key.into(),
                identity.version.into(),
                identity.scope.into(),
                identity.repo_id.into(),
                created_at.into(),
                id.to_string().into(),
            ])
            .unwrap();
        db.execute(&db.pool, &insert).await.unwrap();
    }

    /// Ids of the uploads holding `key`'s reservation. Compared in SQL: `sqlx::Any` cannot decode
    /// Postgres' `char(64)`.
    async fn holders(db: &Db, key: &str) -> Vec<UploadId> {
        let query = Query::select()
            .column(Uploads::Id)
            .from(Uploads::Table)
            .and_where(Expr::col(Uploads::ReservationHash).eq(identity(key).reservation_hash()))
            .to_owned();
        db.all(&db.pool, &query).await.unwrap()
    }

    async fn recorded_migrations(db: &Db) -> Vec<String> {
        sqlx::query("select name from kysely_migration order by name")
            .fetch_all(&db.pool)
            .await
            .unwrap()
            .iter()
            .map(|row| row.try_get(0).unwrap())
            .collect()
    }

    /// Two uploads for one reservation, which the old schema allowed, and another one.
    async fn insert_legacy_uploads(db: &Db) {
        insert_legacy_upload(db, 10, "twice", 100).await;
        insert_legacy_upload(db, 11, "twice", 200).await;
        insert_legacy_upload(db, 12, "once", 100).await;
    }

    async fn assert_reservations_backfilled(db: &Db) {
        assert_eq!(
            holders(db, "twice").await,
            [UploadId { id: 11 }],
            "the newest upload per reservation is kept"
        );
        assert_eq!(
            holders(db, "once").await,
            [UploadId { id: 12 }],
            "every upload is hashed"
        );
        let names: Vec<String> = MIGRATIONS
            .iter()
            .map(|migration| migration.name.to_owned())
            .collect();
        assert_eq!(
            recorded_migrations(db).await,
            names,
            "every migration is recorded"
        );
    }

    /// A SQLite database the TypeScript server created and left at `$6`, with two saved entries.
    #[tokio::test]
    async fn upgrades_a_database_left_by_the_typescript_server() {
        let dir = tempfile::tempdir().unwrap();
        let config = Config::from_vars([
            ("API_BASE_URL".to_owned(), "http://localhost".to_owned()),
            ("DB_DRIVER".to_owned(), "sqlite".to_owned()),
            (
                "DB_SQLITE_PATH".to_owned(),
                dir.path()
                    .join("legacy.sqlite")
                    .to_string_lossy()
                    .into_owned(),
            ),
        ])
        .unwrap();
        let db = Db::open(&config.db).await.unwrap();
        sqlx::raw_sql(include_str!("testdata/kysely-v6.sql"))
            .execute(&db.pool)
            .await
            .unwrap();
        let before: Vec<CacheEntry> = db.all(&db.pool, &select_entries()).await.unwrap();
        insert_legacy_uploads(&db).await;

        assert!(!migrate(&db).await.unwrap(), "no storage clear");

        let after: Vec<CacheEntry> = db.all(&db.pool, &select_entries()).await.unwrap();
        assert_eq!(before.len(), 2, "the fixture holds two entries");
        assert_eq!(after, before, "cache entries are kept");
        assert_reservations_backfilled(&db).await;
    }

    /// The same upgrade on the configured test database, from a `$6` schema built by this
    /// implementation's own DDL.
    #[tokio::test]
    async fn upgrades_a_v6_schema_with_data_on_every_database() {
        let dir = tempfile::tempdir().unwrap();
        let mut vars = harness::db_vars(dir.path()).await;
        vars.push(("API_BASE_URL".to_owned(), "http://localhost".to_owned()));
        let config = Config::from_vars(vars).unwrap();
        let db = Db::open(&config.db).await.unwrap();
        migrate_through(&db, 7).await.unwrap();

        let location = unmerged_location("1");
        harness::insert_location(&db, &location).await;
        let saved = entry("saved", &location.id, 1);
        harness::insert_entry(&db, &saved).await;
        insert_legacy_uploads(&db).await;

        assert!(!migrate(&db).await.unwrap(), "no storage clear");

        let entries: Vec<CacheEntry> = db.all(&db.pool, &select_entries()).await.unwrap();
        assert_eq!(entries, [saved], "cache entries are kept");
        assert_reservations_backfilled(&db).await;
    }
}
