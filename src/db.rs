//! Database access shared by Postgres, MySQL and SQLite through `sqlx::Any`.

mod migrations;

use std::future::Future;
use std::net::Ipv6Addr;
use std::str::FromStr as _;

use sea_query::{
    Asterisk, Expr, Iden, MysqlQueryBuilder, PostgresQueryBuilder, Query, QueryBuilder,
    SelectStatement, SimpleExpr, SqliteQueryBuilder,
};
use sea_query_binder::SqlxBinder;
use serde::Serialize;
use sha2::{Digest as _, Sha256};
use sqlx::any::{AnyConnectOptions, AnyPoolOptions, AnyRow, AnyTypeInfo, AnyValueRef};
use sqlx::mysql::MySqlDatabaseError;
use sqlx::sqlite::SqliteConnectOptions;
use sqlx::{Any, AnyPool, ConnectOptions as _, Executor, FromRow};
use url::Url;
use utoipa::ToSchema;

use crate::config::{DbConfig, PostgresConnection, ServerConnection};
use crate::error::{Failure, Result};

/// SQL dialect of the configured database.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Dialect {
    Postgres,
    Mysql,
    Sqlite,
}

impl Dialect {
    fn builder(self) -> &'static dyn QueryBuilder {
        match self {
            Self::Postgres => &PostgresQueryBuilder,
            Self::Mysql => &MysqlQueryBuilder,
            Self::Sqlite => &SqliteQueryBuilder,
        }
    }

    /// `CAST(COALESCE(SUM(col), 0) AS <64-bit int>)`; plain `SUM` is NUMERIC/DECIMAL on Postgres
    /// and MySQL, which `sqlx::Any` cannot decode.
    pub(crate) fn sum_bigint(self, column: &impl Iden) -> SimpleExpr {
        let column = column.to_string();
        Expr::cust(match self {
            Self::Mysql => format!("CAST(COALESCE(SUM(`{column}`), 0) AS SIGNED)"),
            Self::Postgres | Self::Sqlite => {
                format!(r#"CAST(COALESCE(SUM("{column}"), 0) AS BIGINT)"#)
            }
        })
    }
}

/// Connection pool plus the dialect its queries are rendered for.
#[derive(Debug, Clone)]
pub(crate) struct Db {
    pub(crate) pool: AnyPool,
    pub(crate) dialect: Dialect,
}

/// Rows decoded from any of the supported databases.
pub(crate) trait Record: for<'r> FromRow<'r, AnyRow> + Send + Unpin {}
impl<T: for<'r> FromRow<'r, AnyRow> + Send + Unpin> Record for T {}

impl Db {
    /// Connects and migrates; the flag says whether storage must be cleared (see migrations).
    pub(crate) async fn connect(config: &DbConfig) -> Result<(Self, bool)> {
        let db = Self::open(config).await?;
        let requires_storage_clear = migrations::migrate(&db).await?;
        Ok((db, requires_storage_clear))
    }

    /// Connects without migrating.
    async fn open(config: &DbConfig) -> Result<Self> {
        sqlx::any::install_default_drivers();
        let (url, dialect, max_connections) = match config {
            DbConfig::Postgres(PostgresConnection::Url(url)) => {
                (url.clone(), Dialect::Postgres, 10)
            }
            DbConfig::Postgres(PostgresConnection::Params(params)) => (
                server_url(Dialect::Postgres, params)?,
                Dialect::Postgres,
                10,
            ),
            DbConfig::Mysql(params) => (server_url(Dialect::Mysql, params)?, Dialect::Mysql, 10),
            DbConfig::Sqlite { path } => {
                if let Some(parent) = path
                    .parent()
                    .filter(|parent| !parent.as_os_str().is_empty())
                {
                    tokio::fs::create_dir_all(parent).await?;
                }
                let url = SqliteConnectOptions::new()
                    .filename(path)
                    .create_if_missing(true)
                    .to_url_lossy();
                // SQLite allows one writer; a single connection serializes access the way the
                // database expects instead of surfacing `SQLITE_BUSY` under load.
                (url.into(), Dialect::Sqlite, 1)
            }
        };
        let options = AnyConnectOptions::from_str(&url)?;
        let pool = AnyPoolOptions::new()
            .max_connections(max_connections)
            // A local SQLite file can't go stale, and pinging it on every checkout doubles the
            // queue on its single connection.
            .test_before_acquire(dialect != Dialect::Sqlite)
            .after_connect(move |connection, _meta| {
                Box::pin(async move {
                    // Keys match exactly, like GitHub's; SQLite's `like` ignores ASCII case unless
                    // told otherwise, on every connection.
                    if dialect == Dialect::Sqlite {
                        // WAL commits append to the log and sync only at checkpoints, instead of
                        // syncing a rollback journal and the database on every commit. A crash
                        // can lose the last commits, never consistency; a cache can afford that.
                        for pragma in [
                            "pragma case_sensitive_like = on",
                            "pragma journal_mode = wal",
                            "pragma synchronous = normal",
                        ] {
                            sqlx::query(pragma).execute(&mut *connection).await?;
                        }
                    }
                    Ok(())
                })
            })
            .connect_with(options)
            .await?;
        Ok(Self { pool, dialect })
    }

    fn sql(&self, query: &impl SqlxBinder) -> (String, sea_query_binder::SqlxValues) {
        query.build_any_sqlx(self.dialect.builder())
    }

    pub(crate) async fn all<'c, T: Record>(
        &self,
        executor: impl Executor<'c, Database = Any>,
        query: &(impl SqlxBinder + Sync),
    ) -> Result<Vec<T>> {
        let (sql, values) = self.sql(query);
        Ok(sqlx::query_as_with::<Any, T, _>(&sql, values)
            .fetch_all(executor)
            .await?)
    }

    pub(crate) async fn optional<'c, T: Record>(
        &self,
        executor: impl Executor<'c, Database = Any>,
        query: &(impl SqlxBinder + Sync),
    ) -> Result<Option<T>> {
        let (sql, values) = self.sql(query);
        Ok(sqlx::query_as_with::<Any, T, _>(&sql, values)
            .fetch_optional(executor)
            .await?)
    }

    pub(crate) async fn one<'c, T: Record>(
        &self,
        executor: impl Executor<'c, Database = Any>,
        query: &(impl SqlxBinder + Sync),
    ) -> Result<T> {
        let (sql, values) = self.sql(query);
        Ok(sqlx::query_as_with::<Any, T, _>(&sql, values)
            .fetch_one(executor)
            .await?)
    }

    /// Executes a statement and returns the number of affected rows.
    pub(crate) async fn execute<'c>(
        &self,
        executor: impl Executor<'c, Database = Any>,
        query: &(impl SqlxBinder + Sync),
    ) -> Result<u64> {
        let (sql, values) = self.sql(query);
        Ok(sqlx::query_with(&sql, values)
            .execute(executor)
            .await?
            .rows_affected())
    }
}

/// A connection URL for a database server. IPv6 literals are bracketed, and a host that is a
/// path is a Unix socket directory (Postgres) or file (MySQL), passed as a query parameter.
/// (`to_url_lossy` on the drivers' option builders panics on both.)
fn server_url(dialect: Dialect, params: &ServerConnection) -> Result<String> {
    let (scheme, socket_param) = match dialect {
        Dialect::Postgres => ("postgres", "host"),
        Dialect::Mysql => ("mysql", "socket"),
        Dialect::Sqlite => return Err(Failure::msg("SQLite has no server")),
    };
    let invalid = || Failure::msg(format!("invalid {scheme} connection parameters"));
    let mut url = Url::parse(&format!("{scheme}://localhost")).map_err(|_parse| invalid())?;
    if params.host.starts_with('/') {
        url.query_pairs_mut()
            .append_pair(socket_param, &params.host);
    } else if params.host.parse::<Ipv6Addr>().is_ok() {
        url.set_host(Some(&format!("[{}]", params.host)))
            .map_err(|_parse| invalid())?;
    } else {
        url.set_host(Some(&params.host))
            .map_err(|_parse| invalid())?;
    }
    url.set_port(Some(params.port.get()))
        .map_err(|()| invalid())?;
    url.set_username(&params.user).map_err(|()| invalid())?;
    url.set_password(Some(&params.password))
        .map_err(|()| invalid())?;
    url.path_segments_mut()
        .map_err(|()| invalid())?
        .push(&params.database);
    Ok(url.into())
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
pub(crate) fn is_unique_violation(failure: &Failure) -> bool {
    matches!(failure, Failure::Db(sqlx::Error::Database(error)) if error.is_unique_violation())
}

fn is_retryable_lock_error(failure: &Failure) -> bool {
    let Failure::Db(sqlx::Error::Database(error)) = failure else {
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

// Column names are camelCase: the schema was created by the original TypeScript server.

#[derive(Debug, Clone, Copy, Iden)]
pub(crate) enum CacheEntries {
    Table,
    #[iden = "id"]
    Id,
    #[iden = "key"]
    Key,
    #[iden = "version"]
    Version,
    #[iden = "scope"]
    Scope,
    #[iden = "repoId"]
    RepoId,
    #[iden = "updatedAt"]
    UpdatedAt,
    #[iden = "locationId"]
    LocationId,
}

#[derive(Debug, Clone, Copy, Iden)]
pub(crate) enum StorageLocations {
    Table,
    #[iden = "id"]
    Id,
    #[iden = "folderName"]
    FolderName,
    #[iden = "partCount"]
    PartCount,
    #[iden = "mergeStartedAt"]
    MergeStartedAt,
    #[iden = "mergedAt"]
    MergedAt,
    #[iden = "partsDeletedAt"]
    PartsDeletedAt,
    #[iden = "lastDownloadedAt"]
    LastDownloadedAt,
    #[iden = "sizeBytes"]
    SizeBytes,
}

#[derive(Debug, Clone, Copy, Iden)]
pub(crate) enum MergeLeases {
    Table,
    #[iden = "storageLocationId"]
    StorageLocationId,
    #[iden = "token"]
    Token,
    #[iden = "expiresAt"]
    ExpiresAt,
}

#[derive(Debug, Clone, Copy, Iden)]
pub(crate) enum StorageReaderLeases {
    Table,
    #[iden = "id"]
    Id,
    #[iden = "storageLocationId"]
    StorageLocationId,
    #[iden = "scope"]
    Scope,
    #[iden = "expiresAt"]
    ExpiresAt,
}

#[derive(Debug, Clone, Copy, Iden)]
pub(crate) enum Uploads {
    Table,
    #[iden = "id"]
    Id,
    #[iden = "key"]
    Key,
    #[iden = "version"]
    Version,
    #[iden = "scope"]
    Scope,
    #[iden = "repoId"]
    RepoId,
    #[iden = "createdAt"]
    CreatedAt,
    #[iden = "lastPartUploadedAt"]
    LastPartUploadedAt,
    #[iden = "startedPartUploadCount"]
    StartedPartUploadCount,
    #[iden = "finishedPartUploadCount"]
    FinishedPartUploadCount,
    #[iden = "folderName"]
    FolderName,
    #[iden = "reservationHash"]
    ReservationHash,
}

/// A string column read leniently: through `sqlx::Any`, MySQL reports `text` columns (such as
/// `folderName`, created as `text` by the original schema) as blobs.
#[derive(Debug)]
pub(crate) struct Utf8Text(String);

impl sqlx::Type<Any> for Utf8Text {
    fn type_info() -> AnyTypeInfo {
        <String as sqlx::Type<Any>>::type_info()
    }

    fn compatible(ty: &AnyTypeInfo) -> bool {
        <String as sqlx::Type<Any>>::compatible(ty) || <Vec<u8> as sqlx::Type<Any>>::compatible(ty)
    }
}

impl<'r> sqlx::Decode<'r, Any> for Utf8Text {
    fn decode(value: AnyValueRef<'r>) -> Result<Self, sqlx::error::BoxDynError> {
        match <String as sqlx::Decode<Any>>::decode(value.clone()) {
            Ok(text) => Ok(Self(text)),
            Err(_not_text) => Ok(Self(String::from_utf8(
                <Vec<u8> as sqlx::Decode<Any>>::decode(value)?,
            )?)),
        }
    }
}

impl From<Utf8Text> for String {
    fn from(text: Utf8Text) -> Self {
        text.0
    }
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

/// A cache item available for matching and restoration by a workflow.
#[derive(Debug, Clone, PartialEq, Eq, FromRow, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
#[sqlx(rename_all = "camelCase")]
pub(crate) struct CacheEntry {
    pub(crate) id: String,
    pub(crate) key: String,
    pub(crate) version: String,
    pub(crate) scope: String,
    pub(crate) repo_id: String,
    pub(crate) updated_at: i64,
    pub(crate) location_id: String,
}

/// The stored data belonging to a cache entry.
#[derive(Debug, Clone, PartialEq, Eq, FromRow, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
#[sqlx(rename_all = "camelCase")]
pub(crate) struct StorageLocation {
    pub(crate) id: String,
    #[sqlx(try_from = "Utf8Text")]
    pub(crate) folder_name: String,
    pub(crate) part_count: i64,
    pub(crate) merge_started_at: Option<i64>,
    pub(crate) merged_at: Option<i64>,
    pub(crate) parts_deleted_at: Option<i64>,
    pub(crate) last_downloaded_at: Option<i64>,
    pub(crate) size_bytes: Option<i64>,
}

/// Cache data that is being received but has not yet become a cache entry.
#[derive(Debug, Clone, PartialEq, Eq, FromRow)]
#[sqlx(rename_all = "camelCase")]
pub(crate) struct Upload {
    pub(crate) id: i64,
    pub(crate) key: String,
    pub(crate) version: String,
    pub(crate) scope: String,
    pub(crate) repo_id: String,
    pub(crate) created_at: i64,
    pub(crate) last_part_uploaded_at: Option<i64>,
    pub(crate) started_part_upload_count: i64,
    pub(crate) finished_part_upload_count: i64,
    #[sqlx(try_from = "Utf8Text")]
    pub(crate) folder_name: String,
}

/// Selects whole `storage_locations` rows.
pub(crate) fn select_locations() -> SelectStatement {
    Query::select()
        .column((StorageLocations::Table, Asterisk))
        .from(StorageLocations::Table)
        .to_owned()
}

/// Selects whole `cache_entries` rows.
pub(crate) fn select_entries() -> SelectStatement {
    Query::select()
        .column((CacheEntries::Table, Asterisk))
        .from(CacheEntries::Table)
        .to_owned()
}

pub(crate) async fn insert_location<'c>(
    db: &Db,
    executor: impl Executor<'c, Database = Any>,
    location: &StorageLocation,
) -> Result<()> {
    let mut insert = Query::insert();
    insert
        .into_table(StorageLocations::Table)
        .columns([
            StorageLocations::Id,
            StorageLocations::FolderName,
            StorageLocations::PartCount,
            StorageLocations::MergeStartedAt,
            StorageLocations::MergedAt,
            StorageLocations::PartsDeletedAt,
            StorageLocations::LastDownloadedAt,
            StorageLocations::SizeBytes,
        ])
        .values([
            location.id.as_str().into(),
            location.folder_name.as_str().into(),
            location.part_count.into(),
            location.merge_started_at.into(),
            location.merged_at.into(),
            location.parts_deleted_at.into(),
            location.last_downloaded_at.into(),
            location.size_bytes.into(),
        ])?;
    db.execute(executor, &insert).await?;
    Ok(())
}

pub(crate) async fn insert_entry<'c>(
    db: &Db,
    executor: impl Executor<'c, Database = Any>,
    entry: &CacheEntry,
) -> Result<()> {
    let mut insert = Query::insert();
    insert
        .into_table(CacheEntries::Table)
        .columns([
            CacheEntries::Id,
            CacheEntries::Key,
            CacheEntries::Version,
            CacheEntries::Scope,
            CacheEntries::RepoId,
            CacheEntries::UpdatedAt,
            CacheEntries::LocationId,
        ])
        .values([
            entry.id.as_str().into(),
            entry.key.as_str().into(),
            entry.version.as_str().into(),
            entry.scope.as_str().into(),
            entry.repo_id.as_str().into(),
            entry.updated_at.into(),
            entry.location_id.as_str().into(),
        ])?;
    db.execute(executor, &insert).await?;
    Ok(())
}

/// Which data a Storage Reader Lease protects.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ReaderLeaseScope {
    Parts,
    Storage,
}

impl ReaderLeaseScope {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::Parts => "parts",
            Self::Storage => "storage",
        }
    }
}

/// Single-column projections.
#[derive(Debug, FromRow)]
pub(crate) struct IdRow {
    pub(crate) id: String,
}

#[derive(Debug, FromRow)]
pub(crate) struct TotalRow {
    pub(crate) total: i64,
}

#[derive(Debug, FromRow)]
#[sqlx(rename_all = "camelCase")]
pub(crate) struct UploadFolder {
    pub(crate) id: i64,
    #[sqlx(try_from = "Utf8Text")]
    pub(crate) folder_name: String,
}

#[derive(Debug, FromRow)]
#[sqlx(rename_all = "camelCase")]
pub(crate) struct FolderRow {
    pub(crate) id: String,
    #[sqlx(try_from = "Utf8Text")]
    pub(crate) folder_name: String,
}

#[cfg(test)]
mod tests {
    use std::borrow::Cow;
    use std::sync::atomic::{AtomicU32, Ordering};

    use sqlx::error::{DatabaseError, ErrorKind};

    use super::*;

    #[test]
    fn server_urls_bracket_ipv6_and_pass_sockets() {
        let params = |host: &str| ServerConnection {
            database: "db".to_owned(),
            host: host.to_owned(),
            port: std::num::NonZeroU16::new(5432).unwrap(),
            user: "u".to_owned(),
            password: "p@ss".to_owned(),
        };
        assert_eq!(
            server_url(Dialect::Postgres, &params("::1")).unwrap(),
            "postgres://u:p%40ss@[::1]:5432/db",
            "IPv6 literal"
        );
        assert_eq!(
            server_url(Dialect::Postgres, &params("/run/postgresql")).unwrap(),
            "postgres://u:p%40ss@localhost:5432/db?host=%2Frun%2Fpostgresql",
            "socket directory"
        );
        assert_eq!(
            server_url(Dialect::Mysql, &params("/run/mysqld/mysqld.sock")).unwrap(),
            "mysql://u:p%40ss@localhost:5432/db?socket=%2Frun%2Fmysqld%2Fmysqld.sock",
            "socket file"
        );
    }

    #[derive(Debug, thiserror::Error)]
    #[error("Deadlock found when trying to get lock")]
    struct LockConflict(&'static str);

    impl DatabaseError for LockConflict {
        fn message(&self) -> &'static str {
            "Deadlock found when trying to get lock"
        }

        fn code(&self) -> Option<Cow<'_, str>> {
            Some(Cow::Borrowed(self.0))
        }

        fn as_error(&self) -> &(dyn std::error::Error + Send + Sync + 'static) {
            self
        }

        fn as_error_mut(&mut self) -> &mut (dyn std::error::Error + Send + Sync + 'static) {
            self
        }

        fn into_error(self: Box<Self>) -> Box<dyn std::error::Error + Send + Sync + 'static> {
            self
        }

        fn kind(&self) -> ErrorKind {
            ErrorKind::Other
        }
    }

    fn conflict(code: &'static str) -> Failure {
        Failure::Db(sqlx::Error::Database(Box::new(LockConflict(code))))
    }

    async fn attempts(
        mut outcome: impl FnMut(u32) -> Result<&'static str>,
    ) -> (Result<&'static str>, u32) {
        let calls = AtomicU32::new(0);
        let result = retry_on_lock_conflict(|| {
            let call = calls.fetch_add(1, Ordering::SeqCst);
            std::future::ready(outcome(call))
        })
        .await;
        (result, calls.load(Ordering::SeqCst))
    }

    #[test]
    fn hashes_reservations_like_json_stringify() {
        let identity = |key: &str, version: &str, scope: &str, repo_id: &str| EntryIdentity {
            key: key.to_owned(),
            version: version.to_owned(),
            scope: scope.to_owned(),
            repo_id: repo_id.to_owned(),
        };
        // Expected values from Node: sha256(JSON.stringify([key, version, scope, repoId])).
        assert_eq!(
            identity("k", "v", "refs/heads/main", "123").reservation_hash(),
            "368889f52b85df29800ec2fc541d9cabc7a6d458ae6d2f9aff8b9089ad687b9c",
            "plain strings"
        );
        assert_eq!(
            identity("Café-ü 🚀", "v\"1\\x", "s\n\t\u{1}\u{1f}/", "r\u{2028}").reservation_hash(),
            "ce7cc7ffb27b7bae72e437beb98081837c5501e72d6316e03a0bbf43f6a2bda1",
            "non-ASCII, quotes, backslashes and control characters"
        );
    }

    #[tokio::test]
    async fn retries_a_deadlock_victim_until_it_succeeds() {
        let (result, calls) = attempts(|call| {
            if call == 0 {
                Err(conflict("40001"))
            } else {
                Ok("merged")
            }
        })
        .await;
        assert_eq!(result.unwrap(), "merged", "the retry succeeds");
        assert_eq!(calls, 2, "one retry");
    }

    #[tokio::test]
    async fn gives_up_after_the_attempt_limit() {
        let (result, calls) = attempts(|_| Err(conflict("40P01"))).await;
        assert!(result.is_err(), "the last conflict is returned");
        assert_eq!(calls, RETRY_ATTEMPTS, "every attempt is used");
    }

    #[tokio::test]
    async fn does_not_retry_other_failures() {
        let (result, calls) = attempts(|_| Err(Failure::msg("Merge lease was lost"))).await;
        assert!(result.is_err(), "the failure is returned");
        assert_eq!(calls, 1, "no retry");
    }
}
