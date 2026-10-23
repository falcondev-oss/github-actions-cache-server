//! Upload reservations, block uploads to missing uploads, and exact key matching.

use futures_util::future::join_all;
use sea_query::{Expr, Query};

use super::harness::{TestServer, byte_stream, identity, query, save_parts};
use crate::db::{CacheEntry, Uploads};
use crate::storage::{CreatedUpload, Storage};

async fn save(storage: &Storage, key: &str) {
    save_parts(storage, key, &[key.as_bytes().to_vec()]).await;
}

/// The entry a lookup for `keys` (primary first) matches, if any.
async fn matched(storage: &Storage, keys: &[&str]) -> Option<CacheEntry> {
    storage
        .match_cache_entry(&query(keys))
        .await
        .unwrap()
        .map(|found| found.entry)
}

async fn matched_key(storage: &Storage, keys: &[&str]) -> Option<String> {
    matched(storage, keys).await.map(|entry| entry.key)
}

#[tokio::test]
async fn concurrent_reservations_create_exactly_one_upload() {
    let server = TestServer::start().await;
    let reservation = identity(&uuid::Uuid::new_v4().to_string());
    let results = join_all((0..10).map(|_| server.storage().create_upload(&reservation))).await;
    let created = results
        .iter()
        .filter(|result| matches!(result, Ok(CreatedUpload::Created { .. })))
        .count();
    let rejected = results
        .iter()
        .filter(|result| matches!(result, Ok(CreatedUpload::AlreadyExists)))
        .count();
    assert_eq!(
        (created, rejected),
        (1, 9),
        "one reservation wins, the rest already exist"
    );
}

#[tokio::test]
async fn completing_an_upload_leaves_a_reservation_differing_in_case_alone() {
    let server = TestServer::start().await;
    let storage = server.storage();
    let key = format!("Key-{}", uuid::Uuid::new_v4());
    let CreatedUpload::Created { id: upper } =
        storage.create_upload(&identity(&key)).await.unwrap()
    else {
        panic!("fresh key");
    };
    save(storage, &key.to_lowercase()).await;

    assert!(
        storage
            .upload_part(upper, 0, byte_stream("x"))
            .await
            .unwrap(),
        "the upper-case reservation is untouched"
    );
}

#[tokio::test]
async fn keys_differing_in_case_accents_or_trailing_spaces_stay_separate() {
    let server = TestServer::start().await;
    let storage = server.storage();
    let id = uuid::Uuid::new_v4();
    save(storage, &format!("CaseFoo-{id}")).await;
    save(storage, &format!("Café-{id}")).await;
    save(storage, &format!("Pad-{id}")).await;

    assert_eq!(
        matched_key(storage, &[&format!("casefoo-{id}")]).await,
        None,
        "case"
    );
    assert_eq!(
        matched_key(storage, &[&format!("nomatch-{id}"), "casefoo-"]).await,
        None,
        "case in a restore-key prefix"
    );
    assert_eq!(
        matched_key(storage, &[&format!("Cafe-{id}")]).await,
        None,
        "accents"
    );
    assert_eq!(
        matched_key(storage, &[&format!("Pad-{id} ")]).await,
        None,
        "trailing space"
    );

    save(storage, &format!("casefoo-{id}")).await;
    let upper = matched(storage, &[&format!("CaseFoo-{id}")]).await.unwrap();
    let lower = matched(storage, &[&format!("casefoo-{id}")]).await.unwrap();
    assert_eq!(
        upper.key,
        format!("CaseFoo-{id}"),
        "upper case matches itself"
    );
    assert_eq!(
        lower.key,
        format!("casefoo-{id}"),
        "lower case matches itself"
    );
    assert_ne!(upper.location_id, lower.location_id, "separate storage");
}

#[tokio::test]
async fn a_non_numeric_upload_id_is_a_bad_request() {
    let server = TestServer::start().await;
    let response = reqwest::Client::new()
        .put(format!("{}/devstoreaccount1/upload/abc", server.url))
        .body("payload")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 400, "status");
    assert!(
        response
            .text()
            .await
            .unwrap()
            .contains("uploadId must be a number"),
        "the original message"
    );
}

#[tokio::test]
async fn blocks_for_unknown_uploads_are_rejected_and_not_written() {
    let server = TestServer::start().await;
    let response = reqwest::Client::new()
        .put(format!("{}/devstoreaccount1/upload/-1", server.url))
        .body("payload")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 404, "unknown upload");
    assert!(
        server
            .adapter()
            .list_storage_folders()
            .await
            .unwrap()
            .is_empty(),
        "nothing was written"
    );
}

#[tokio::test]
async fn a_part_whose_upload_is_deleted_mid_stream_is_not_recorded() {
    let server = TestServer::start().await;
    let storage = server.storage();
    let CreatedUpload::Created { id } = storage
        .create_upload(&identity("deleted-mid-part"))
        .await
        .unwrap()
    else {
        panic!("fresh key");
    };
    let db = storage.db.clone();
    // Deletes the upload, the way `cleanup:uploads` would, while the part is streaming.
    let body = futures_util::stream::once(async move {
        db.execute(
            &db.pool,
            Query::delete()
                .from_table(Uploads::Table)
                .and_where(Expr::col(Uploads::Id).eq(id)),
        )
        .await
        .unwrap();
        Ok(axum::body::Bytes::from_static(b"payload"))
    });
    let recorded = storage
        .upload_part(id, 0, futures_util::StreamExt::boxed(body))
        .await
        .unwrap();
    assert!(!recorded, "the part belongs to no upload any more");
}
