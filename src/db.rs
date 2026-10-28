//! Database access shared by Postgres, MySQL and SQLite through `SeaORM`.

mod entities;
mod migrations;

use std::future::Future;
use std::str::FromStr as _;

use sea_orm::sea_query::{Alias, Expr, ExprTrait as _, Func, LikeExpr};
use sea_orm::{
    ColumnTrait, DatabaseConnection, DbErr, EntityTrait as _, QuerySelect as _, RuntimeErr, SqlErr,
};
use sha2::{Digest as _, Sha256};
use sqlx::mysql::{MySqlConnectOptions, MySqlDatabaseError, MySqlPoolOptions};
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous};

pub(crate) use self::entities::storage_reader_leases::ReaderLeaseScope;
pub(crate) use self::entities::{
    cache_entries, merge_leases, storage_locations, storage_reader_leases, uploads,
};
use crate::config::{DbConfig, PostgresConnection, ServerConnection};
use crate::error::{Failure, Result};

pub(crate) type CacheEntry = cache_entries::Model;
pub(crate) type StorageLocation = storage_locations::Model;
pub(crate) type Upload = uploads::Model;

/// SQL dialect of the configured database.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Dialect {
    Postgres,
    Mysql,
    Sqlite,
}

impl Dialect {
    /// `column` starts with `prefix`, compared exactly.
    pub(crate) fn starts_with(self, column: impl ColumnTrait, prefix: &str) -> Expr {
        match self {
            // A LIKE pattern bound as a parameter makes SQLite recompile the statement on every
            // run, which cost half of a lookup; neither form can use an index here.
            Self::Sqlite => Func::cust("substr")
                .args([
                    column.into_expr(),
                    Expr::val(1),
                    Expr::val(i64::try_from(prefix.chars().count()).unwrap_or(i64::MAX)),
                ])
                .eq(prefix),
            // MySQL can serve a LIKE prefix from the key index. `!` escapes, since a backslash
            // literal reads differently under MySQL's `NO_BACKSLASH_ESCAPES`.
            Self::Postgres | Self::Mysql => {
                let escaped = prefix
                    .replace('!', "!!")
                    .replace('%', "!%")
                    .replace('_', "!_");
                column.like(LikeExpr::new(format!("{escaped}%")).escape('!'))
            }
        }
    }

    /// `CAST(COALESCE(SUM(column), 0) AS <64-bit int>)`; plain `SUM` is NUMERIC/DECIMAL on
    /// Postgres and MySQL, which doesn't decode as `i64`.
    pub(crate) fn sum_bigint(self, column: impl ColumnTrait) -> Expr {
        let int64 = match self {
            Self::Mysql => "SIGNED",
            Self::Postgres | Self::Sqlite => "BIGINT",
        };
        Func::coalesce([column.into_expr().sum(), Expr::val(0)]).cast_as(Alias::new(int64))
    }
}

/// SQLite read connections; WAL readers don't block each other or the writer.
const READ_CONNECTIONS: u32 = 8;
const SERVER_CONNECTIONS: u32 = 10;
const IN_MEMORY: &str = ":memory:";

/// Connection pools plus the dialect their queries are rendered for.
#[derive(Debug, Clone)]
pub(crate) struct Db {
    pub(crate) pool: DatabaseConnection,
    /// For reads outside a transaction. On SQLite these are separate read-only connections,
    /// which WAL lets run alongside the single writer; elsewhere it is `pool`.
    pub(crate) reads: DatabaseConnection,
    pub(crate) dialect: Dialect,
}

impl Db {
    /// Connects and migrates; the flag says whether storage must be cleared (see migrations).
    pub(crate) async fn connect(config: &DbConfig) -> Result<(Self, bool)> {
        let db = Self::open(config).await?;
        let requires_storage_clear = migrations::migrate(&db).await?;
        Ok((db, requires_storage_clear))
    }

    /// Connects without migrating.
    async fn open(config: &DbConfig) -> Result<Self> {
        let (pool, dialect, reads) = match config {
            DbConfig::Postgres(connection) => {
                let options = match connection {
                    PostgresConnection::Url(url) => PgConnectOptions::from_str(url)?,
                    // A host that is a path is the Unix socket directory.
                    PostgresConnection::Params(params) => PgConnectOptions::new()
                        .host(&params.host)
                        .port(params.port.get())
                        .username(&params.user)
                        .password(&params.password)
                        .database(&params.database),
                };
                let pool = PgPoolOptions::new()
                    .max_connections(SERVER_CONNECTIONS)
                    .connect_with(options)
                    .await?;
                (pool.into(), Dialect::Postgres, None)
            }
            DbConfig::Mysql(params) => {
                let pool = MySqlPoolOptions::new()
                    .max_connections(SERVER_CONNECTIONS)
                    .connect_with(mysql_options(params))
                    .await?;
                (pool.into(), Dialect::Mysql, None)
            }
            DbConfig::Sqlite { path } => {
                // SQLite allows one writer; a single connection serializes access the way the
                // database expects instead of surfacing `SQLITE_BUSY` under load. A local file
                // can't go stale, and pinging it on every checkout doubles the queue on it.
                let pool_options = || SqlitePoolOptions::new().test_before_acquire(false);
                if path.as_os_str() == IN_MEMORY {
                    // An in-memory database lives in its one connection, so it has no readers
                    // and is gone once that connection closes.
                    let pool = pool_options()
                        .max_connections(1)
                        .min_connections(1)
                        .idle_timeout(None)
                        .max_lifetime(None)
                        .connect_with(SqliteConnectOptions::new().in_memory(true))
                        .await?;
                    (pool.into(), Dialect::Sqlite, None)
                } else {
                    if let Some(parent) = path
                        .parent()
                        .filter(|parent| !parent.as_os_str().is_empty())
                    {
                        tokio::fs::create_dir_all(parent).await?;
                    }
                    let file = SqliteConnectOptions::new().filename(path);
                    // WAL commits append to the log and sync only at checkpoints, instead of
                    // syncing a rollback journal and the database on every commit. A crash can
                    // lose the last commits, never consistency; a cache can afford that. The
                    // journal mode is stored in the file, so read-only connections inherit it.
                    let writer = file
                        .clone()
                        .create_if_missing(true)
                        .journal_mode(SqliteJournalMode::Wal)
                        .synchronous(SqliteSynchronous::Normal)
                        // A checkpoint syncs the log and the database file, inline in a commit;
                        // every 1000 pages (the default) that stalls the writer tens of times a
                        // second under load.
                        .pragma("wal_autocheckpoint", "10000");
                    let pool = pool_options()
                        .max_connections(1)
                        .connect_with(writer)
                        .await?;
                    // Lazy: the writer has to create the file and switch it to WAL first.
                    let reads = pool_options()
                        .max_connections(READ_CONNECTIONS)
                        .connect_lazy_with(file.read_only(true));
                    (pool.into(), Dialect::Sqlite, Some(reads.into()))
                }
            }
        };
        Ok(Self {
            reads: reads.unwrap_or_else(|| DatabaseConnection::clone(&pool)),
            pool,
            dialect,
        })
    }

    /// Bytes of all stored data, from the recorded payload sizes.
    pub(crate) async fn stored_bytes(&self) -> Result<i64> {
        let total: Option<i64> = storage_locations::Entity::find()
            .select_only()
            .expr(
                self.dialect
                    .sum_bigint(storage_locations::Column::SizeBytes),
            )
            .into_tuple()
            .one(&self.pool)
            .await?;
        Ok(total.unwrap_or(0))
    }
}

/// A host that is a path is the Unix socket file.
fn mysql_options(params: &ServerConnection) -> MySqlConnectOptions {
    let options = MySqlConnectOptions::new()
        .port(params.port.get())
        .username(&params.user)
        .password(&params.password)
        .database(&params.database);
    if params.host.starts_with('/') {
        options.socket(&params.host)
    } else {
        options.host(&params.host)
    }
}

/// Milliseconds since the Unix epoch, the unit of every timestamp column.
pub(crate) fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

const RETRY_ATTEMPTS: u32 = 3;

/// Runs a transaction, retrying it whole if the database picks it as a deadlock victim.
///
/// Concurrent writers take row locks on `storage_locations` and the lease tables in differing
/// orders, so a deadlock is expected rather than exceptional; the loser has to start over. Only
/// wrap transactions that are safe to repeat.
pub(crate) async fn retry_on_lock_conflict<T, F, Fut>(mut run: F) -> Result<T>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<T>>,
{
    let mut attempt = 1;
    loop {
        match run().await {
            Err(failure) if attempt < RETRY_ATTEMPTS && is_retryable_lock_error(&failure) => {
                tracing::warn!(
                    attempt,
                    error = %failure,
                    "retrying transaction after lock conflict"
                );
                attempt = attempt.saturating_add(1);
            }
            result => return result,
        }
    }
}

/// Whether a statement was rejected by a unique constraint.
pub(crate) fn is_unique_violation(error: &DbErr) -> bool {
    matches!(error.sql_err(), Some(SqlErr::UniqueConstraintViolation(_)))
}

fn is_retryable_lock_error(failure: &Failure) -> bool {
    let Failure::Db(
        DbErr::Conn(RuntimeErr::SqlxError(error))
        | DbErr::Exec(RuntimeErr::SqlxError(error))
        | DbErr::Query(RuntimeErr::SqlxError(error)),
    ) = failure
    else {
        return false;
    };
    let sqlx::Error::Database(error) = &**error else {
        return false;
    };
    // Postgres `serialization_failure` / `deadlock_detected`; MySQL reports its deadlock as 40001.
    if error
        .code()
        .is_some_and(|code| code == "40001" || code == "40P01")
    {
        return true;
    }
    // MySQL `ER_LOCK_WAIT_TIMEOUT` and `ER_LOCK_DEADLOCK`.
    error
        .try_downcast_ref::<MySqlDatabaseError>()
        .is_some_and(|error| matches!(error.number(), 1205 | 1213))
}

/// The key, version, scope and repository a cache entry or upload is saved under. At most one
/// upload may hold a reservation at a time.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct EntryIdentity {
    pub(crate) key: String,
    pub(crate) version: String,
    pub(crate) scope: String,
    pub(crate) repo_id: String,
}

impl EntryIdentity {
    /// SHA-256 of the JSON array `[key, version, scope, repoId]`, byte-identical to the original
    /// server's `JSON.stringify`, so both can share a database during a rollout.
    pub(crate) fn reservation_hash(&self) -> String {
        let tuple = [&self.key, &self.version, &self.scope, &self.repo_id];
        // Serializing an array of strings cannot fail.
        let json = serde_json::to_vec(&tuple).unwrap_or_default();
        format!("{:x}", Sha256::digest(json))
    }
}

#[cfg(test)]
mod tests;
