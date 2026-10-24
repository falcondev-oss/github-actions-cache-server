//! The cache protocol end to end: what `@actions/cache` (JSON) and sccache (protobuf) do.

use prost::Message as _;

use super::harness::{TestServer, VERSION};
use crate::twirp::{
    CreateCacheEntryResponse, FinalizeCacheEntryUploadResponse, GetCacheEntryDownloadUrlResponse,
};

fn payload(size: usize) -> Vec<u8> {
    (0..size)
        .map(|index| u8::try_from(index % 251).unwrap())
        .collect()
}

#[tokio::test]
async fn saves_and_restores_unmerged_then_merged() {
    let server = TestServer::start().await;
    let client = server.client();
    for size in [1, 300_000] {
        let key = format!("roundtrip-{size}");
        let data = payload(size);
        client.save(&key, &data, 64 * 1024).await;

        // The first restore streams the Parts and merges them on the way.
        let first = client.restore(&key, &[]).await;
        assert_eq!(
            first,
            Some((key.clone(), data.clone())),
            "restored from parts"
        );
        server.storage().wait_for_ongoing_merges().await;

        let merged = client
            .restore("missing-primary", &["roundtrip-"])
            .await
            .unwrap();
        assert!(
            merged.0.starts_with("roundtrip-"),
            "restore key prefix matches"
        );
        let latest = client.restore(&key, &[]).await;
        assert_eq!(latest, Some((key, data)), "restored from the merged object");
    }
}

#[tokio::test]
async fn dangling_entries_are_misses_after_storage_is_wiped() {
    let server = TestServer::start().await;
    let client = server.client();

    client.save("wiped-before-merge", b"data", 1024).await;
    server.adapter().clear().await.unwrap();
    assert_eq!(
        client.restore("wiped-before-merge", &[]).await,
        None,
        "unmerged parts gone"
    );
    assert_eq!(
        client.restore("wiped-before-merge", &[]).await,
        None,
        "entry was purged"
    );

    client.save("wiped-after-merge", b"data", 1024).await;
    assert!(
        client.restore("wiped-after-merge", &[]).await.is_some(),
        "hit merges"
    );
    server.storage().wait_for_ongoing_merges().await;
    server.adapter().clear().await.unwrap();
    assert_eq!(
        client.restore("wiped-after-merge", &[]).await,
        None,
        "merged object gone"
    );
    assert_eq!(
        client.restore("wiped-after-merge", &[]).await,
        None,
        "entry was purged"
    );
}

#[derive(Clone, PartialEq, Eq, prost::Message)]
struct Metadata {
    #[prost(int64, tag = "1")]
    repository_id: i64,
}

/// Client-side schemas carry `metadata`, a field the server does not declare.
#[derive(Clone, PartialEq, Eq, prost::Message)]
struct CreateRequest {
    #[prost(message, optional, tag = "1")]
    metadata: Option<Metadata>,
    #[prost(string, tag = "2")]
    key: String,
    #[prost(string, tag = "3")]
    version: String,
}

#[derive(Clone, PartialEq, Eq, prost::Message)]
struct FinalizeRequest {
    #[prost(message, optional, tag = "1")]
    metadata: Option<Metadata>,
    #[prost(string, tag = "2")]
    key: String,
    #[prost(int64, tag = "3")]
    size_bytes: i64,
    #[prost(string, tag = "4")]
    version: String,
}

#[derive(Clone, PartialEq, Eq, prost::Message)]
struct GetRequest {
    #[prost(message, optional, tag = "1")]
    metadata: Option<Metadata>,
    #[prost(string, tag = "2")]
    key: String,
    #[prost(string, repeated, tag = "3")]
    restore_keys: Vec<String>,
    #[prost(string, tag = "4")]
    version: String,
}

const METADATA: Option<Metadata> = Some(Metadata { repository_id: 123 });

async fn protobuf<T: prost::Message + Default>(response: reqwest::Response) -> T {
    assert_eq!(response.status(), 200, "protobuf call succeeds");
    let content_type = response.headers()["content-type"]
        .to_str()
        .unwrap()
        .to_owned();
    assert!(
        content_type.contains("application/protobuf"),
        "answered in protobuf"
    );
    T::decode(response.bytes().await.unwrap()).unwrap()
}

#[tokio::test]
async fn speaks_protobuf_twirp() {
    let server = TestServer::start().await;
    let client = server.client();
    let create = CreateRequest {
        metadata: METADATA,
        key: "proto-key".to_owned(),
        version: VERSION.to_owned(),
    };

    let created: CreateCacheEntryResponse = protobuf(
        client
            .twirp_protobuf("CreateCacheEntry", create.encode_to_vec())
            .await,
    )
    .await;
    assert!(created.ok, "entry is reserved");
    assert!(
        created
            .signed_upload_url
            .contains("/devstoreaccount1/upload/"),
        "upload url"
    );

    // Twirp errors are JSON even when the request was protobuf.
    let duplicate = client
        .twirp_protobuf("CreateCacheEntry", create.encode_to_vec())
        .await;
    assert_eq!(duplicate.status(), 409, "duplicate reservation");
    assert_eq!(
        duplicate.json::<serde_json::Value>().await.unwrap(),
        serde_json::json!({
            "code": "already_exists",
            "msg": "cache entry with the same key, version, and scope already exists",
        }),
        "already_exists error"
    );

    client
        .upload_blocks(&created.signed_upload_url, b"proto-data", 4)
        .await;
    let finalize = FinalizeRequest {
        metadata: METADATA,
        key: "proto-key".to_owned(),
        size_bytes: 10,
        version: VERSION.to_owned(),
    };
    let finalized: FinalizeCacheEntryUploadResponse = protobuf(
        client
            .twirp_protobuf("FinalizeCacheEntryUpload", finalize.encode_to_vec())
            .await,
    )
    .await;
    assert!(
        finalized.ok && finalized.entry_id > 0,
        "upload is finalized"
    );

    let lookup = |key: &str| GetRequest {
        metadata: METADATA,
        key: key.to_owned(),
        restore_keys: vec!["fallback-a".to_owned(), "proto-".to_owned()],
        version: VERSION.to_owned(),
    };
    let hit: GetCacheEntryDownloadUrlResponse = protobuf(
        client
            .twirp_protobuf(
                "GetCacheEntryDownloadURL",
                lookup("no-such-key").encode_to_vec(),
            )
            .await,
    )
    .await;
    assert!(hit.ok, "restore_keys are decoded");
    assert_eq!(
        hit.matched_key, "proto-key",
        "matched by restore key prefix"
    );
    let body = reqwest::get(&hit.signed_download_url)
        .await
        .unwrap()
        .bytes()
        .await
        .unwrap();
    assert_eq!(body.as_ref(), b"proto-data", "downloaded payload");

    let miss = GetRequest {
        restore_keys: Vec::new(),
        ..lookup("no-such-key")
    };
    let missed: GetCacheEntryDownloadUrlResponse = protobuf(
        client
            .twirp_protobuf("GetCacheEntryDownloadURL", miss.encode_to_vec())
            .await,
    )
    .await;
    assert!(!missed.ok, "miss is ok: false");

    // 404, not 400, proves the protobuf body was decoded and validated.
    let never = FinalizeRequest {
        key: "never-uploaded".to_owned(),
        ..finalize
    };
    let response = client
        .twirp_protobuf("FinalizeCacheEntryUpload", never.encode_to_vec())
        .await;
    assert_eq!(response.status(), 404, "missing upload");
}

#[tokio::test]
async fn rejects_tokens_without_write_scope_for_saves() {
    let server = TestServer::start().await;
    let reader = super::harness::CacheClient::new(&server.url, &[("refs/heads/main", 1)]);
    let response = reader
        .twirp(
            "CreateCacheEntry",
            &serde_json::json!({ "key": "k", "version": VERSION }),
        )
        .await;
    assert_eq!(response.status(), 403, "read-only scope cannot save");
}

fn sample(metrics: &str, series: &str) -> f64 {
    metrics
        .lines()
        .find_map(|line| line.strip_prefix(series)?.strip_prefix(' ')?.parse().ok())
        .unwrap_or(0.0)
}

#[tokio::test]
async fn counts_uploads_hits_misses_and_stored_bytes() {
    let server = TestServer::start().await;
    let client = server.client();
    client.save("metrics-key", &payload(4096), 1024).await;
    assert!(client.restore("metrics-key", &[]).await.is_some(), "hit");
    assert!(client.restore("metrics-miss", &[]).await.is_none(), "miss");

    let response = reqwest::get(format!("{}/metrics", server.url))
        .await
        .unwrap();
    assert!(
        response.headers()["content-type"]
            .to_str()
            .unwrap()
            .contains("text/plain"),
        "prometheus text format"
    );
    let metrics = response.text().await.unwrap();
    assert!(
        metrics.contains("process_start_time_seconds"),
        "process metrics are wired up"
    );
    assert_eq!(
        sample(&metrics, "cache_uploads_total").to_string(),
        "1",
        "uploads"
    );
    assert_eq!(
        sample(&metrics, r#"cache_requests_total{result="hit"}"#).to_string(),
        "1",
        "hits"
    );
    assert_eq!(
        sample(&metrics, r#"cache_requests_total{result="miss"}"#).to_string(),
        "1",
        "misses"
    );
    assert_eq!(
        sample(&metrics, "cache_storage_bytes").to_string(),
        "4096",
        "stored bytes"
    );
}
