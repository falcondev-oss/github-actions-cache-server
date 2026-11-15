//! Downloads: HTTP ranges, merges, dangling entries and reader leases.

use std::time::Duration;

use futures_util::StreamExt as _;
use sea_orm::ActiveValue::Set;
use sea_orm::{EntityTrait as _, QueryFilter as _};

use super::harness::{
    TestServer, entry, eventually, find_location, insert_entry, insert_location, merged_location,
    put, query, read_all, save_parts, storage_driver, unmerged_location,
};
use crate::db::{StorageLocation, merge_leases, now_ms, storage_reader_leases};

const PART: usize = 64 * 1024;

/// Three Parts of an odd total size, not a multiple of any chunk size a client would pick.
fn parts() -> Vec<Vec<u8>> {
    let byte = |index: usize| u8::try_from(index % 253).unwrap();
    vec![
        (0..PART).map(byte).collect(),
        (PART..2 * PART).map(byte).collect(),
        (2 * PART..2 * PART + 12_345).map(byte).collect(),
    ]
}

async fn merged_entry(server: &TestServer) -> (StorageLocation, Vec<u8>) {
    let location = save_parts(
        server.storage(),
        &uuid::Uuid::new_v4().to_string(),
        &parts(),
    )
    .await;
    let first = server
        .storage()
        .download(&location.id, None)
        .await
        .unwrap()
        .unwrap();
    read_all(first.stream).await.unwrap();
    server.storage().wait_for_ongoing_merges().await;
    (location, parts().concat())
}

async fn get(server: &TestServer, id: &str, range: Option<&str>) -> reqwest::Response {
    get_with(server, id, "range", range).await
}

async fn get_with(
    server: &TestServer,
    id: &str,
    header: &str,
    range: Option<&str>,
) -> reqwest::Response {
    let mut request = reqwest::Client::new().get(format!("{}/download/{id}", server.url));
    if let Some(range) = range {
        request = request.header(header, range);
    }
    request.send().await.unwrap()
}

fn response_header(response: &reqwest::Response, name: &str) -> Option<String> {
    response
        .headers()
        .get(name)
        .map(|value| value.to_str().unwrap().to_owned())
}

/// Every range shape, including ones crossing and starting on Part boundaries, answered 206 with
/// exactly the requested bytes, and a range past the end answered 416.
#[expect(
    clippy::arithmetic_side_effects,
    reason = "offsets into a fixture of a few hundred KiB"
)]
async fn assert_serves_ranges(server: &TestServer, id: &str, expected: &[u8], header: &str) {
    let total = expected.len();
    let cases = [
        ("bytes=4096-8191".to_owned(), 4096, 8191),
        (
            format!("bytes={}-{}", PART - 6, PART + 9),
            PART - 6,
            PART + 9,
        ),
        (format!("bytes={PART}-"), PART, total - 1),
        (format!("bytes={}-", total - 100), total - 100, total - 1),
        (
            format!("bytes={}-{}", total - 10, total + 5000),
            total - 10,
            total - 1,
        ),
        ("bytes=-100".to_owned(), total - 100, total - 1),
    ];
    for (range, start, end) in cases {
        let response = get_with(server, id, header, Some(&range)).await;
        assert_eq!(response.status(), 206, "{header}: {range}");
        assert_eq!(
            response_header(&response, "content-range"),
            Some(format!("bytes {start}-{end}/{total}")),
            "{header}: {range}"
        );
        assert_eq!(
            response_header(&response, "content-length"),
            Some((end - start + 1).to_string()),
            "{header}: {range}"
        );
        assert_eq!(
            response.bytes().await.unwrap(),
            expected[start..=end],
            "{header}: {range}"
        );
    }

    let past_end = get_with(server, id, header, Some(&format!("bytes={total}-"))).await;
    assert_eq!(
        past_end.status(),
        416,
        "{header}: range starting at the end"
    );
    assert_eq!(
        response_header(&past_end, "content-range"),
        Some(format!("bytes */{total}")),
        "{header}: size reported"
    );
}

#[tokio::test]
async fn serves_ranges_of_merged_entries() {
    let server = TestServer::start().await;
    let (location, expected) = merged_entry(&server).await;
    let total = expected.len();

    let whole = get(&server, &location.id, None).await;
    assert_eq!(whole.status(), 200, "no range");
    assert_eq!(
        response_header(&whole, "accept-ranges").as_deref(),
        Some("bytes"),
        "ranges advertised"
    );
    assert_eq!(
        response_header(&whole, "content-length"),
        Some(total.to_string()),
        "length"
    );
    assert_eq!(whole.bytes().await.unwrap(), expected, "whole body");

    assert_serves_ranges(&server, &location.id, &expected, "range").await;

    let unparseable = get(&server, &location.id, Some("bytes=abc")).await;
    assert_eq!(unparseable.status(), 200, "unparseable range falls through");
    assert_eq!(unparseable.bytes().await.unwrap(), expected, "whole body");
}

#[tokio::test]
async fn serves_ranges_of_unmerged_entries_and_pins_bytes_to_a_location() {
    let server = TestServer::start().await;
    let key = uuid::Uuid::new_v4().to_string();
    let first = save_parts(server.storage(), &key, &parts()).await;
    let resaved = save_parts(server.storage(), &key, &[b"re".to_vec(), b"saved".to_vec()]).await;
    assert_ne!(first.id, resaved.id, "a re-save gets a new location");

    let stale = get(&server, &first.id, Some("bytes=0-10")).await;
    assert_eq!(
        stale.status(),
        404,
        "the replaced location is no longer served"
    );
    let response = get(&server, &resaved.id, Some("bytes=1-3")).await;
    assert_eq!(response.status(), 206, "a range across two Parts");
    assert_eq!(
        response_header(&response, "content-range").as_deref(),
        Some("bytes 1-3/7"),
        "content-range"
    );
    assert_eq!(
        response.bytes().await.unwrap().as_ref(),
        b"esa",
        "ranged body"
    );

    // The Azure SDK (BuildKit's `type=gha`) resumes with `x-ms-range` and takes any 200 body as the
    // bytes from its offset, so an unmerged entry must never fall back to serving itself whole.
    let unmerged = save_parts(server.storage(), "unmerged", &parts()).await;
    for header in ["range", "x-ms-range"] {
        assert_serves_ranges(&server, &unmerged.id, &parts().concat(), header).await;
    }
    assert_eq!(
        find_location(server.db(), &unmerged.id)
            .await
            .unwrap()
            .merged_at,
        None,
        "ranges were served from the Parts"
    );

    let single = save_parts(server.storage(), "single", &[b"one part".to_vec()]).await;
    let ranged = get(&server, &single.id, Some("bytes=4-7")).await;
    assert_eq!(
        ranged.status(),
        206,
        "a single Part needs no Merge to serve ranges"
    );
    assert_eq!(
        response_header(&ranged, "content-range"),
        Some("bytes 4-7/8".to_owned()),
        "content-range"
    );
    assert_eq!(
        ranged.bytes().await.unwrap().as_ref(),
        b"part",
        "ranged body"
    );
}

#[tokio::test]
async fn an_empty_entry_ignores_ranges_on_every_backend() {
    let server = TestServer::start().await;
    let location = save_parts(server.storage(), "empty", &[Vec::new()]).await;
    for range in ["bytes=0-", "bytes=5-"] {
        let response = get(&server, &location.id, Some(range)).await;
        assert_eq!(response.status(), 200, "{range}");
        assert_eq!(response_header(&response, "content-range"), None, "{range}");
        assert_eq!(
            response_header(&response, "content-length").as_deref(),
            Some("0"),
            "{range}"
        );
        assert!(response.bytes().await.unwrap().is_empty(), "{range}");
    }
}

#[tokio::test]
async fn eager_merge_writes_the_merged_object_at_completion() {
    let eager = TestServer::with(&[("EAGER_MERGE", "true")]).await;
    let location = save_parts(eager.storage(), "eager", &parts()).await;
    eager.storage().wait_for_ongoing_merges().await;
    let current = find_location(eager.db(), &location.id).await.unwrap();
    assert!(current.merged_at.is_some(), "merge completed");
    let merged = eager
        .adapter()
        .download_stream(&format!("{}/merged", location.folder_name), None)
        .await
        .unwrap();
    assert_eq!(
        read_all(merged.stream).await.unwrap(),
        parts().concat(),
        "merged bytes"
    );

    let lazy = TestServer::start().await;
    let lazy_location = save_parts(lazy.storage(), "lazy", &parts()).await;
    lazy.storage().wait_for_ongoing_merges().await;
    assert!(lazy_location.merged_at.is_none(), "not merged");
    let merged_name = format!("{}/merged", lazy_location.folder_name);
    assert!(
        !lazy.adapter().object_exists(&merged_name).await.unwrap(),
        "left to first download"
    );
}

/// An unmerged entry; without `part` data it is a Dangling Cache Entry.
async fn seed(server: &TestServer, key: &str, part: Option<&'static [u8]>) -> (String, String) {
    let folder = uuid::Uuid::new_v4().to_string();
    if let Some(data) = part {
        put(server.adapter(), &format!("{folder}/parts/0"), data).await;
    }
    let seeded = unmerged_location(&folder);
    insert_location(server.db(), &seeded).await;
    let seeded_entry = entry(key, &seeded.id, now_ms());
    insert_entry(server.db(), &seeded_entry).await;
    (seeded_entry.id, seeded.id)
}

#[tokio::test]
async fn self_heals_dangling_entries_at_lookup() {
    let server = TestServer::start().await;
    let (_, dangling_location) = seed(&server, "dangling", None).await;
    let result = server
        .storage()
        .cache_entry_with_download_url(&query(&["dangling"]))
        .await;
    assert_eq!(result.unwrap(), None, "a dangling entry is a miss");
    assert_eq!(
        find_location(server.db(), &dangling_location).await,
        None,
        "location purged"
    );
    assert_eq!(
        server
            .storage()
            .match_cache_entry(&query(&["dangling"]))
            .await
            .unwrap(),
        None,
        "entry purged"
    );

    seed(&server, "build-cache-stale", None).await;
    let (valid, _) = seed(&server, "build-cache-good", Some(b"data")).await;
    let matched = server
        .storage()
        .cache_entry_with_download_url(&query(&["build-cache-stale", "build-cache-good"]))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        matched.entry.id, valid,
        "falls through to a valid restore key"
    );
}

#[tokio::test]
async fn a_download_fails_once_its_reader_lease_is_lost() {
    let server = TestServer::start().await;
    let (_, location_id) = seed(&server, "lost-lease", Some(b"data")).await;
    // Another worker holds the merge, so this download only reads Parts.
    merge_leases::Entity::insert(merge_leases::ActiveModel {
        storage_location_id: Set(location_id.clone()),
        token: Set("other".to_owned()),
        expires_at: Set(now_ms() + 60_000),
    })
    .exec_without_returning(&server.db().pool)
    .await
    .unwrap();

    let mut download = server
        .storage()
        .download(&location_id, None)
        .await
        .unwrap()
        .unwrap();
    storage_reader_leases::Entity::delete_many()
        .filter(
            storage_reader_leases::COLUMN
                .storage_location_id
                .eq(location_id.as_str()),
        )
        .exec(&server.db().pool)
        .await
        .unwrap();
    // A renewal attempt notices the lease is gone.
    tokio::time::sleep(Duration::from_millis(500)).await;
    let item = download.stream.next().await.unwrap();
    assert!(
        item.is_err(),
        "the stream fails instead of serving unprotected data"
    );
}

#[tokio::test]
async fn a_direct_download_lease_outlives_the_signed_url() {
    // Only S3 signs URLs against the emulators used in tests.
    if storage_driver() != "s3" {
        return;
    }
    let server = TestServer::with(&[
        ("ENABLE_DIRECT_DOWNLOADS", "true"),
        (
            "UNSAFE_ALLOW_DIRECT_DOWNLOADS_WITHOUT_TOKEN_VALIDATION",
            "true",
        ),
        ("DIRECT_DOWNLOAD_URL_TTL_SECONDS", "120"),
    ])
    .await;
    let folder = uuid::Uuid::new_v4().to_string();
    put(
        server.adapter(),
        &format!("{folder}/merged"),
        b"merged-data",
    )
    .await;
    let location = merged_location(&folder);
    insert_location(server.db(), &location).await;
    insert_entry(server.db(), &entry("direct", &location.id, now_ms())).await;

    let started_at = now_ms();
    let matched = server
        .storage()
        .cache_entry_with_download_url(&query(&["direct"]))
        .await
        .unwrap()
        .unwrap();
    let url = url::Url::parse(&matched.download_url).unwrap();
    let lifetime_seconds: i64 = url
        .query_pairs()
        .find(|(name, _)| name == "X-Amz-Expires")
        .map(|(_, value)| value.parse().unwrap())
        .unwrap();
    let lease = storage_reader_leases::Entity::find()
        .filter(
            storage_reader_leases::COLUMN
                .storage_location_id
                .eq(location.id.as_str()),
        )
        .one(&server.db().pool)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(lifetime_seconds, 120, "configured url lifetime");
    assert!(
        lease.expires_at - started_at >= (120 + 10 * 60) * 1000,
        "lease outlives the url by the margin"
    );
    let accessed = find_location(server.db(), &location.id)
        .await
        .unwrap()
        .last_downloaded_at;
    assert!(accessed.unwrap() >= started_at, "Cache Access is recorded");
    let body = reqwest::get(matched.download_url)
        .await
        .unwrap()
        .bytes()
        .await
        .unwrap();
    assert_eq!(
        body.as_ref(),
        b"merged-data",
        "the signed url serves the object"
    );
}

#[tokio::test]
async fn closes_a_download_whose_client_stopped_reading() {
    // The timeout sits on the connection, the same on every backend; emulators reject the upload.
    if storage_driver() != "filesystem" {
        return;
    }
    let server = TestServer::with(&[("DOWNLOAD_IDLE_TIMEOUT_MS", "200")]).await;
    let folder = uuid::Uuid::new_v4().to_string();
    // Far more than the socket buffers between server and client hold.
    let data: &'static [u8] = Box::leak(vec![7_u8; 32 * 1024 * 1024].into_boxed_slice());
    put(server.adapter(), &format!("{folder}/merged"), data).await;
    let location = merged_location(&folder);
    insert_location(server.db(), &location).await;
    insert_entry(server.db(), &entry("idle", &location.id, now_ms())).await;

    let response = get(&server, &location.id, None).await;
    assert_eq!(response.status(), 200);
    let lease = || async {
        storage_reader_leases::Entity::find()
            .filter(
                storage_reader_leases::COLUMN
                    .storage_location_id
                    .eq(location.id.as_str()),
            )
            .one(&server.db().pool)
            .await
            .unwrap()
    };
    assert!(lease().await.is_some(), "the download holds a reader lease");
    eventually(|| async { lease().await.is_none() }).await;
    assert!(
        response.bytes().await.is_err(),
        "the client sees a failed download, not a complete one"
    );
}
