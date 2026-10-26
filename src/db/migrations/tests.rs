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
    sqlx::query_scalar("select name from kysely_migration order by name")
        .fetch_all(&db.pool)
        .await
        .unwrap()
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
    sqlx::raw_sql(include_str!("../testdata/kysely-v6.sql"))
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
