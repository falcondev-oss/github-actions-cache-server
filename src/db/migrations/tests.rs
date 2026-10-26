use super::*;
use crate::config::Config;
use crate::db::cache_entries;
use crate::tests::harness::{self, entry, identity, unmerged_location};

async fn insert_legacy_upload(db: &Db, id: i64, key: &str, created_at: i64) {
    let identity = identity(key);
    uploads::Entity::insert(uploads::ActiveModel {
        id: Set(id),
        key: Set(identity.key),
        version: Set(identity.version),
        scope: Set(identity.scope),
        repo_id: Set(identity.repo_id),
        created_at: Set(created_at),
        folder_name: Set(id.to_string()),
        ..Default::default()
    })
    .exec_without_returning(&db.pool)
    .await
    .unwrap();
}

/// Ids of the uploads holding `key`'s reservation.
async fn holders(db: &Db, key: &str) -> Vec<i64> {
    uploads::Entity::find()
        .select_only()
        .column(uploads::Column::Id)
        .filter(
            uploads::COLUMN
                .reservation_hash
                .eq(identity(key).reservation_hash()),
        )
        .into_tuple()
        .all(&db.pool)
        .await
        .unwrap()
}

async fn recorded_migrations(db: &Db) -> Vec<String> {
    strings(
        &db.pool,
        "select name from kysely_migration order by name".to_owned(),
    )
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
        [11],
        "the newest upload per reservation is kept"
    );
    assert_eq!(holders(db, "once").await, [12], "every upload is hashed");
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
    db.pool
        .execute_unprepared(include_str!("../testdata/kysely-v6.sql"))
        .await
        .unwrap();
    let before = cache_entries::Entity::find().all(&db.pool).await.unwrap();
    insert_legacy_uploads(&db).await;

    assert!(!migrate(&db).await.unwrap(), "no storage clear");

    let after = cache_entries::Entity::find().all(&db.pool).await.unwrap();
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

    let entries = cache_entries::Entity::find().all(&db.pool).await.unwrap();
    assert_eq!(entries, [saved], "cache entries are kept");
    assert_reservations_backfilled(&db).await;
}
