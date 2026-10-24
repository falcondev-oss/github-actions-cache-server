//! Management API authentication, bulk deletion filters and reader-aware deletion.

use super::harness::{
    TestServer, entry, eventually, find_location, insert_entry, insert_location, merged_location,
    put, unmerged_location,
};
use crate::db::{CacheEntry, now_ms};

#[tokio::test]
async fn bulk_deletion_respects_every_filter() {
    let server = TestServer::with(&[("MANAGEMENT_API_KEY", "secret")]).await;
    let stored = unmerged_location("shared");
    insert_location(server.db(), &stored).await;
    let kept = CacheEntry {
        repo_id: "other-repo".to_owned(),
        ..entry("same-key", &stored.id, now_ms())
    };
    insert_entry(server.db(), &kept).await;
    insert_entry(server.db(), &entry("same-key", &stored.id, now_ms())).await;
    let http = reqwest::Client::new();
    let entries = format!("{}/management-api/cache-entries", server.url);

    let unauthorized = http
        .delete(&entries)
        .query(&[("key", "same-key")])
        .send()
        .await
        .unwrap();
    assert_eq!(unauthorized.status(), 401, "the api key is required");

    // The original server read the filters from a JSON body only.
    let deleted = http
        .delete(&entries)
        .header("x-api-key", "secret")
        .json(&serde_json::json!({ "key": "same-key", "repoId": "123" }))
        .send()
        .await
        .unwrap();
    assert_eq!(deleted.status(), 200, "deleted");

    let remaining: serde_json::Value = http
        .get(&entries)
        .header("x-api-key", "secret")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        remaining["total"], 1,
        "the other repository's entry survives"
    );
    assert_eq!(remaining["items"][0]["id"], kept.id.as_str(), "kept entry");
}

#[tokio::test]
async fn is_unavailable_without_an_api_key() {
    let server = TestServer::start().await;
    let response = reqwest::get(format!("{}/management-api/cache-entries", server.url))
        .await
        .unwrap();
    assert_eq!(response.status(), 503, "disabled");
}

#[tokio::test]
async fn storage_location_deletion_waits_for_readers() {
    let server = TestServer::with(&[("MANAGEMENT_API_KEY", "secret")]).await;
    // Merged, so reading it starts no background merge that could outlive the deletion.
    let location = merged_location(&uuid::Uuid::new_v4().to_string());
    put(
        server.adapter(),
        &format!("{}/merged", location.folder_name),
        b"payload",
    )
    .await;
    insert_location(server.db(), &location).await;
    insert_entry(server.db(), &entry("being-read", &location.id, now_ms())).await;
    let reading = server
        .storage()
        .download(&location.id, None)
        .await
        .unwrap()
        .unwrap();
    let url = format!(
        "{}/management-api/storage-locations/{}",
        server.url, location.id
    );
    let delete = || {
        reqwest::Client::new()
            .delete(&url)
            .header("x-api-key", "secret")
            .send()
    };

    assert_eq!(
        delete().await.unwrap().status(),
        409,
        "a download is reading it"
    );
    assert!(
        find_location(server.db(), &location.id).await.is_some(),
        "the row is kept"
    );

    drop(reading);
    eventually(|| async { delete().await.unwrap().status() == 200 }).await;
    assert!(
        find_location(server.db(), &location.id).await.is_none(),
        "the row is deleted"
    );
    assert!(
        server
            .adapter()
            .list_folder(&location.folder_name)
            .await
            .unwrap()
            .is_empty(),
        "and its data"
    );
}
