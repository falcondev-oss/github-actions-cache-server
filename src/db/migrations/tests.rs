use super::*;
use crate::config::Config;
use crate::db::cache_entries;
use crate::tests::harness;

async fn sqlite(fixture: &str) -> (tempfile::TempDir, Db) {
    let dir = tempfile::tempdir().unwrap();
    let config = Config::from_vars([
        ("API_BASE_URL".to_owned(), "http://localhost".to_owned()),
        ("DB_DRIVER".to_owned(), "sqlite".to_owned()),
        (
            "DB_SQLITE_PATH".to_owned(),
            dir.path().join("v9.sqlite").to_string_lossy().into_owned(),
        ),
    ])
    .unwrap();
    let db = Db::open(&config.db).await.unwrap();
    db.pool.execute_unprepared(fixture).await.unwrap();
    (dir, db)
}

async fn has_kysely_table(db: &Db) -> bool {
    SchemaManager::new(&db.pool)
        .has_table("kysely_migration")
        .await
        .unwrap()
}

#[tokio::test]
async fn adopts_a_v9_10_database_with_its_data() {
    let (_dir, db) = sqlite(include_str!("../testdata/kysely-v9.sql")).await;
    let before = cache_entries::Entity::find().all(&db.pool).await.unwrap();

    assert!(!migrate(&db).await.unwrap(), "storage is kept");
    assert!(!migrate(&db).await.unwrap(), "a second run changes nothing");

    assert_eq!(before.len(), 2, "the fixture holds two entries");
    assert_eq!(
        cache_entries::Entity::find().all(&db.pool).await.unwrap(),
        before,
        "cache entries are kept"
    );
    assert!(!has_kysely_table(&db).await, "Kysely's bookkeeping is gone");
}

#[tokio::test]
async fn keeps_a_migrated_database_beside_recreated_v9_bookkeeping() {
    let (_dir, db) = sqlite(include_str!("../testdata/kysely-v9.sql")).await;
    migrate(&db).await.unwrap();
    db.pool
        .execute_unprepared("create table kysely_migration (name varchar(255) primary key)")
        .await
        .unwrap();

    assert!(!migrate(&db).await.unwrap(), "storage is kept");
    assert_eq!(entry_count(&db).await, 2, "cache entries are kept");
    assert!(!has_kysely_table(&db).await, "Kysely's bookkeeping is gone");
}

#[tokio::test]
async fn resumes_an_adoption_interrupted_after_installing_the_migration_table() {
    let (_dir, db) = sqlite(include_str!("../testdata/kysely-v9.sql")).await;
    Migrator::install(&db.pool).await.unwrap();

    assert!(!migrate(&db).await.unwrap(), "storage is kept");
    assert_eq!(entry_count(&db).await, 2, "cache entries are kept");
}

#[tokio::test]
async fn drops_a_database_older_than_v9_10() {
    let (_dir, db) = sqlite(include_str!("../testdata/kysely-v6.sql")).await;

    assert!(migrate(&db).await.unwrap(), "storage is cleared");

    assert_eq!(entry_count(&db).await, 0, "cache entries are gone");
    assert!(!has_kysely_table(&db).await, "Kysely's bookkeeping is gone");
}

/// The configured test database as v9 left it, after `applied` migrations, with one entry.
async fn v9_database(applied: &[&str]) -> (tempfile::TempDir, Db) {
    let dir = tempfile::tempdir().unwrap();
    let mut vars = harness::db_vars(dir.path()).await;
    vars.push(("API_BASE_URL".to_owned(), "http://localhost".to_owned()));
    let db = Db::open(&Config::from_vars(vars).unwrap().db)
        .await
        .unwrap();
    Migrator::up(&db.pool, None).await.unwrap();
    Migrator::uninstall(&db.pool).await.unwrap();
    db.pool
        .execute_unprepared("create table kysely_migration (name varchar(255) primary key)")
        .await
        .unwrap();
    for name in applied {
        db.pool
            .execute_unprepared(&format!("insert into kysely_migration values ('{name}')"))
            .await
            .unwrap();
    }
    let location = harness::unmerged_location("1");
    harness::insert_location(&db, &location).await;
    harness::insert_entry(&db, &harness::entry("saved", &location.id, 1)).await;
    (dir, db)
}

#[tokio::test]
async fn recreates_a_half_applied_baseline_on_every_database() {
    let dir = tempfile::tempdir().unwrap();
    let mut vars = harness::db_vars(dir.path()).await;
    vars.push(("API_BASE_URL".to_owned(), "http://localhost".to_owned()));
    let db = Db::open(&Config::from_vars(vars).unwrap().db)
        .await
        .unwrap();
    Migrator::install(&db.pool).await.unwrap();
    db.pool
        .execute_unprepared("create table storage_locations (id varchar(36) primary key)")
        .await
        .unwrap();

    assert!(!migrate(&db).await.unwrap(), "nothing to clear");
    assert_eq!(entry_count(&db).await, 0, "the schema is complete");
}

async fn entry_count(db: &Db) -> usize {
    cache_entries::Entity::find()
        .all(&db.pool)
        .await
        .unwrap()
        .len()
}

#[tokio::test]
async fn takes_over_v9_databases_on_every_database() {
    let (_current_dir, current) = v9_database(&V9_MIGRATIONS).await;
    assert!(!migrate(&current).await.unwrap(), "storage is kept");
    assert_eq!(
        entry_count(&current).await,
        1,
        "a v9.10 database keeps its data"
    );

    // Dropping has to respect foreign keys.
    let (_older_dir, older) = v9_database(&V9_MIGRATIONS[..1]).await;
    assert!(migrate(&older).await.unwrap(), "storage is cleared");
    assert_eq!(entry_count(&older).await, 0, "an older database is dropped");
}
