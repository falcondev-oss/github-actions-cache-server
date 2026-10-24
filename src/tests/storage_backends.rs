//! Adapter behaviour every backend must share, plus backend-specific edges.

use std::time::Duration;

use super::harness::{TestServer, put, storage_driver};
use crate::storage::Adapter;

#[tokio::test]
async fn folder_operations_do_not_match_sibling_prefixes() {
    let server = TestServer::start().await;
    let adapter = server.adapter();
    put(adapter, "abc/merged", b"a").await;
    put(adapter, "abc123/merged", b"bb").await;

    let objects = adapter.list_folder("abc").await.unwrap();
    assert_eq!(objects, [1], "only the folder's own object");
    let deleted = adapter.delete_folder("abc").await.unwrap();
    assert_eq!(
        (deleted.objects, deleted.bytes),
        (1, 1),
        "deletes only the folder"
    );
    assert!(
        adapter.object_exists("abc123/merged").await.unwrap(),
        "sibling survives"
    );
}

#[tokio::test]
async fn signed_download_urls_serve_the_object() {
    // fake-gcs-server runs without signing credentials.
    if !matches!(storage_driver().as_str(), "s3" | "azblob") {
        return;
    }
    let server = TestServer::start().await;
    put(server.adapter(), "direct/blob", b"hello-direct").await;
    let Adapter::Object(store) = server.adapter() else {
        panic!("object storage");
    };
    let url = store
        .create_download_url("direct/blob", Duration::from_mins(1))
        .await
        .unwrap();
    let response = reqwest::get(url).await.unwrap();
    assert_eq!(response.status(), 200, "signed url is accepted");
    assert_eq!(
        response.bytes().await.unwrap().as_ref(),
        b"hello-direct",
        "object content"
    );
}
