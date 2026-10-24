//! Capacity-based Eviction, cleanup tasks and Orphaned Storage reconciliation.

use std::time::Duration;

use super::harness::{
    TestServer, entry, eventually, find_location, identity, insert_entry, insert_location,
    merged_location, put, read_all, save_parts, storage_driver, unmerged_location,
};
use crate::cleanup::{CleanupSummary, Task, reconcile_orphaned_storage};
use crate::db::{StorageLocation, now_ms};
use crate::error::{Failure, Result};
use crate::storage::CreatedUpload;

const DAY_MS: i64 = 24 * 60 * 60 * 1000;

/// One reconciliation with a one-day grace period, as of `now`.
async fn reconcile(server: &TestServer, now: i64) -> Result<(CleanupSummary, Vec<Failure>)> {
    let (mut summary, mut failures) = (CleanupSummary::default(), Vec::new());
    reconcile_orphaned_storage(
        server.storage(),
        Duration::from_hours(24),
        now,
        &mut summary,
        &mut failures,
    )
    .await?;
    Ok((summary, failures))
}

/// A stored, unmerged location with one entry pointing at it.
async fn seed(server: &TestServer, data: &'static [u8], updated_at: i64) -> StorageLocation {
    let folder = uuid::Uuid::new_v4().to_string();
    put(server.adapter(), &format!("{folder}/parts/0"), data).await;
    let location = unmerged_location(&folder);
    insert_location(server.db(), &location).await;
    insert_entry(
        server.db(),
        &entry(&uuid::Uuid::new_v4().to_string(), &location.id, updated_at),
    )
    .await;
    location
}

async fn part_count(server: &TestServer, folder: &str) -> usize {
    server
        .adapter()
        .list_folder(&format!("{folder}/parts"))
        .await
        .unwrap()
        .len()
}

#[tokio::test]
async fn evicts_least_recently_used_entries_only_after_exceeding_the_budget() {
    let server = TestServer::start().await;
    let mut old = unmerged_location(&uuid::Uuid::new_v4().to_string());
    let mut recent = unmerged_location(&uuid::Uuid::new_v4().to_string());
    old.size_bytes = Some(6);
    recent.size_bytes = Some(6);
    recent.last_downloaded_at = Some(now_ms());
    for (index, location) in [&old, &recent].into_iter().enumerate() {
        put(
            server.adapter(),
            &format!("{}/parts/0", location.folder_name),
            b"123456",
        )
        .await;
        insert_location(server.db(), location).await;
        let updated_at = now_ms() - (2 - i64::try_from(index).unwrap()) * 1000;
        insert_entry(
            server.db(),
            &entry(&uuid::Uuid::new_v4().to_string(), &location.id, updated_at),
        )
        .await;
    }

    let at_budget = server.storage_with(&[("CACHE_MAX_SIZE_BYTES", "12")]).await;
    at_budget.enforce_storage_budget().await.unwrap();
    assert!(
        find_location(server.db(), &old.id).await.is_some(),
        "within budget: nothing evicted"
    );

    let over_budget = server.storage_with(&[("CACHE_MAX_SIZE_BYTES", "11")]).await;
    over_budget.enforce_storage_budget().await.unwrap();
    assert!(
        find_location(server.db(), &old.id).await.is_none(),
        "least recently used is evicted"
    );
    assert!(
        find_location(server.db(), &recent.id).await.is_some(),
        "evicts only down to 90%"
    );
    assert_eq!(
        part_count(&server, &old.folder_name).await,
        0,
        "its data is deleted"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn finalization_succeeds_when_eviction_fails() {
    use std::os::unix::fs::PermissionsExt as _;

    if storage_driver() != "filesystem" {
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("storage");
    let root_path = root.to_string_lossy().into_owned();
    let server = TestServer::with(&[
        ("STORAGE_FILESYSTEM_PATH", &root_path),
        ("CACHE_MAX_SIZE_BYTES", "1"),
    ])
    .await;
    let CreatedUpload::Created { id } = server
        .storage()
        .create_upload(&identity("evict"))
        .await
        .unwrap()
    else {
        panic!("fresh key");
    };
    server
        .storage()
        .upload_part(id, 0, super::harness::byte_stream(&b"payload"[..]))
        .await
        .unwrap();

    // Eviction picks the new location but cannot delete its folder.
    let set_mode =
        |mode| std::fs::set_permissions(&root, std::fs::Permissions::from_mode(mode)).unwrap();
    set_mode(0o555);
    let writable = std::fs::write(root.join("probe"), b"").is_ok();
    let completed = server.storage().complete_upload(&identity("evict")).await;
    set_mode(0o755);
    if writable {
        return; // running as root: permissions cannot make the deletion fail
    }
    assert!(
        completed.unwrap().is_some(),
        "the upload is finalized regardless"
    );
}

#[tokio::test]
async fn reconciles_missing_location_sizes_at_startup() {
    let server = TestServer::start().await;
    let folder = uuid::Uuid::new_v4().to_string();
    put(server.adapter(), &format!("{folder}/parts/0"), b"payload").await;
    let unsized_location = unmerged_location(&folder);
    insert_location(server.db(), &unsized_location).await;

    server
        .storage_with(&[("CACHE_MAX_SIZE_BYTES", "100")])
        .await;
    let reconciled = find_location(server.db(), &unsized_location.id)
        .await
        .unwrap();
    assert_eq!(
        reconciled.size_bytes,
        Some(7),
        "size backfilled from storage"
    );
}

#[tokio::test]
async fn retention_drains_more_than_one_page() {
    let server = TestServer::start().await;
    let mut expired = Vec::new();
    for _ in 0..11 {
        expired.push(seed(&server, b"expired", now_ms() - 91 * DAY_MS).await);
    }
    let fresh = seed(&server, b"fresh", now_ms()).await;

    let summary = server
        .state
        .cleanup
        .run(Task::CacheEntries)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(summary.deleted_locations, 11, "every expired location");
    for location in &expired {
        assert!(
            find_location(server.db(), &location.id).await.is_none(),
            "row deleted"
        );
        assert_eq!(
            part_count(&server, &location.folder_name).await,
            0,
            "data deleted"
        );
    }
    assert!(
        find_location(server.db(), &fresh.id).await.is_some(),
        "fresh entries stay"
    );
}

#[tokio::test]
async fn part_cleanup_waits_for_an_active_parts_download() {
    let server = TestServer::start().await;
    let location = save_parts(
        server.storage(),
        "parts-reader",
        &[b"cache-".to_vec(), b"data".to_vec()],
    )
    .await;
    let storage = server.storage();
    let merging = storage.download(&location.id, None).await.unwrap().unwrap();
    let reading_parts = storage.download(&location.id, None).await.unwrap().unwrap();
    read_all(merging.stream).await.unwrap();
    storage.wait_for_ongoing_merges().await;

    server
        .state
        .cleanup
        .run(Task::Parts)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        part_count(&server, &location.folder_name).await,
        2,
        "parts are still being read"
    );

    read_all(reading_parts.stream).await.unwrap();
    eventually(|| async {
        server
            .state
            .cleanup
            .run(Task::Parts)
            .await
            .unwrap()
            .unwrap();
        part_count(&server, &location.folder_name).await == 0
    })
    .await;
    let merged = storage.download(&location.id, None).await.unwrap().unwrap();
    assert_eq!(
        read_all(merged.stream).await.unwrap(),
        b"cache-data",
        "served from the merge"
    );
}

#[tokio::test]
async fn location_cleanup_waits_for_an_active_merged_download() {
    let server = TestServer::start().await;
    let folder = uuid::Uuid::new_v4().to_string();
    put(
        server.adapter(),
        &format!("{folder}/merged"),
        b"merged-data",
    )
    .await;
    let merged = merged_location(&folder);
    insert_location(server.db(), &merged).await;
    insert_entry(server.db(), &entry("merged-reader", &merged.id, now_ms())).await;

    let download = server
        .storage()
        .download(&merged.id, None)
        .await
        .unwrap()
        .unwrap();
    server
        .db()
        .execute(
            &server.db().pool,
            sea_query::Query::delete().from_table(crate::db::CacheEntries::Table),
        )
        .await
        .unwrap();
    server
        .state
        .cleanup
        .run(Task::StorageLocations)
        .await
        .unwrap()
        .unwrap();
    assert!(
        find_location(server.db(), &merged.id).await.is_some(),
        "kept while being read"
    );

    read_all(download.stream).await.unwrap();
    eventually(|| async {
        server
            .state
            .cleanup
            .run(Task::StorageLocations)
            .await
            .unwrap()
            .unwrap();
        find_location(server.db(), &merged.id).await.is_none()
    })
    .await;
    assert!(
        server
            .adapter()
            .list_folder(&folder)
            .await
            .unwrap()
            .is_empty(),
        "data deleted"
    );
}

#[tokio::test]
async fn failed_finalization_removes_the_upload_folder() {
    let server = TestServer::start().await;
    let CreatedUpload::Created { id } = server
        .storage()
        .create_upload(&identity("partial"))
        .await
        .unwrap()
    else {
        panic!("fresh key");
    };
    put(server.adapter(), &format!("{id}/untracked"), b"partial").await;

    let error = server
        .storage()
        .complete_upload(&identity("partial"))
        .await
        .unwrap_err();
    assert!(
        error.to_string().contains("No parts have been uploaded"),
        "{error}"
    );
    assert!(
        server
            .adapter()
            .list_folder(&id.to_string())
            .await
            .unwrap()
            .is_empty(),
        "folder removed"
    );
}

#[tokio::test]
async fn orphan_reconciliation_deletes_only_unauthorized_expired_folders() {
    let server = TestServer::start().await;
    let CreatedUpload::Created { id } = server
        .storage()
        .create_upload(&identity("authorized"))
        .await
        .unwrap()
    else {
        panic!("fresh key");
    };
    put(server.adapter(), &format!("{id}/parts/0"), b"authorized").await;
    put(server.adapter(), "orphaned/parts/0", b"orphaned").await;
    put(server.adapter(), "orphaned/parts/1", b"!").await;

    let hours_25 = 25 * 60 * 60 * 1000;
    let (summary, failures) = reconcile(&server, now_ms() + hours_25).await.unwrap();
    assert!(failures.is_empty(), "no failures");
    assert_eq!(summary.deleted_folders, 1, "only the orphan");
    assert_eq!(
        (summary.deleted_objects, summary.deleted_bytes),
        (2, 9),
        "reclaimed what was deleted"
    );
    assert_eq!(
        part_count(&server, &id.to_string()).await,
        1,
        "authorized by its upload"
    );
    assert_eq!(part_count(&server, "orphaned").await, 0, "orphan deleted");

    let (within_grace, _) = {
        put(server.adapter(), "young/parts/0", b"young").await;
        reconcile(&server, now_ms()).await.unwrap()
    };
    assert_eq!(
        within_grace.grace_period_folders, 1,
        "young orphans wait out the grace period"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn orphan_reconciliation_deletes_nothing_when_the_inventory_fails() {
    if storage_driver() != "filesystem" {
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("storage");
    let root_path = root.to_string_lossy().into_owned();
    let server = TestServer::with(&[("STORAGE_FILESYSTEM_PATH", &root_path)]).await;
    put(server.adapter(), "orphaned/parts/0", b"orphaned").await;
    // The inventory refuses symbolic links, so it cannot complete.
    std::os::unix::fs::symlink(dir.path(), root.join("link")).unwrap();

    let result = reconcile(&server, now_ms() + 2 * DAY_MS).await;
    assert!(result.is_err(), "an incomplete inventory fails closed");
    assert_eq!(
        part_count(&server, "orphaned").await,
        1,
        "nothing was deleted"
    );
}
