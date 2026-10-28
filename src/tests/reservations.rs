//! Upload reservations, block upload authorization, and exact key matching.

use base64::Engine as _;
use futures_util::future::join_all;
use sea_orm::ActiveValue::Set;
use sea_orm::EntityTrait as _;

use super::harness::{
    SCOPE, TestServer, byte_stream, entry, identity, insert_entry, insert_location, query,
    save_parts, unmerged_location,
};
use crate::db::{CacheEntry, uploads};
use crate::storage::{CreatedUpload, MatchType, Storage};

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
    let CreatedUpload::Created { upload: upper, .. } =
        storage.create_upload(&identity(&key)).await.unwrap()
    else {
        panic!("fresh key");
    };
    save(storage, &key.to_lowercase()).await;

    assert!(
        storage
            .upload_part(&upper, 0, byte_stream("x"), None)
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
async fn restore_key_prefixes_match_wildcards_literally() {
    let server = TestServer::start().await;
    let storage = server.storage();
    save(storage, "wild-xy-1").await;
    for prefix in ["wild-%", "wild-_y", "wild-x!", r"wild-x\"] {
        assert_eq!(
            matched_key(storage, &["missing", prefix]).await,
            None,
            "{prefix} is not a pattern"
        );
    }
    for key in ["wild-%!_\\-1", "wild-%!_\\-2"] {
        save(storage, key).await;
    }
    assert_eq!(
        matched_key(storage, &["missing", "wild-%!_\\-"])
            .await
            .as_deref(),
        Some("wild-%!_\\-2"),
        "literal prefix"
    );
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
async fn upload_requests_without_the_upload_capability_are_forbidden() {
    let server = TestServer::start().await;
    let CreatedUpload::Created { upload, capability } = server
        .storage()
        .create_upload(&identity("signed"))
        .await
        .unwrap()
    else {
        panic!("fresh key");
    };
    let url = format!("{}/devstoreaccount1/upload/{}", server.url, upload.id);
    let http = reqwest::Client::new();
    let block_id = base64::engine::general_purpose::STANDARD.encode(format!(
        "{}{:012}",
        uuid::Uuid::new_v4(),
        0
    ));
    let put = |query: &[(&str, &str)], sig: Option<&str>| {
        http.put(&url)
            .query(query)
            .query(&sig.map(|sig| [("sig", sig)]).unwrap_or_default())
            .body("payload")
            .send()
    };
    let requests: [&[(&str, &str)]; 3] = [
        &[],
        &[("comp", "block"), ("blockid", &block_id)],
        &[("comp", "blocklist")],
    ];
    for query in requests {
        for sig in [None, Some("wrong")] {
            let response = put(query, sig).await.unwrap();
            assert_eq!(response.status(), 403, "{query:?} with sig {sig:?}");
        }
    }
    assert!(
        server
            .adapter()
            .list_storage_folders()
            .await
            .unwrap()
            .is_empty(),
        "nothing was written"
    );
    assert_eq!(
        http.post(format!("{url}?sig={capability}"))
            .send()
            .await
            .unwrap()
            .status(),
        405,
        "only PUT is accepted"
    );
    assert_eq!(
        put(&[], Some(&capability)).await.unwrap().status(),
        201,
        "the capability grants the upload"
    );

    // Uploads created before capabilities existed can't be continued.
    uploads::Entity::update_many()
        .set(uploads::ActiveModel {
            capability_hash: Set(None),
            ..Default::default()
        })
        .exec(&server.db().pool)
        .await
        .unwrap();
    assert_eq!(
        put(&[], Some(&capability)).await.unwrap().status(),
        403,
        "an upload without a capability hash"
    );
}

#[tokio::test]
async fn a_part_whose_upload_is_deleted_mid_stream_is_not_recorded() {
    let server = TestServer::start().await;
    let storage = server.storage();
    let CreatedUpload::Created { upload, .. } = storage
        .create_upload(&identity("deleted-mid-part"))
        .await
        .unwrap()
    else {
        panic!("fresh key");
    };
    let (db, id) = (storage.db.clone(), upload.id);
    // Deletes the upload, the way `cleanup:uploads` would, while the part is streaming.
    let body = futures_util::stream::once(async move {
        uploads::Entity::delete_by_id(id)
            .exec(&db.pool)
            .await
            .unwrap();
        Ok(axum::body::Bytes::from_static(b"payload"))
    });
    let recorded = storage
        .upload_part(&upload, 0, futures_util::StreamExt::boxed(body), None)
        .await
        .unwrap();
    assert!(!recorded, "the part belongs to no upload any more");
}

#[tokio::test]
async fn matches_scopes_then_keys_then_exact_before_prefix() {
    let server = TestServer::start().await;
    let (db, storage) = (server.db(), server.storage());
    let location = unmerged_location("folder");
    insert_location(db, &location).await;
    let feature = "refs/heads/feature";
    for (key, scope, updated_at) in [
        ("primary-old", SCOPE, 1),
        ("primary-new", SCOPE, 2),
        ("restore", SCOPE, 3),
        ("restore-newer", SCOPE, 4),
        ("primary", feature, 5),
    ] {
        insert_entry(
            db,
            &CacheEntry {
                scope: scope.to_owned(),
                ..entry(key, &location.id, updated_at)
            },
        )
        .await;
    }
    let lookup = |keys: &[&str], scopes: &[&str]| {
        let mut query = query(keys);
        query.scopes = scopes.iter().map(|&scope| scope.to_owned()).collect();
        async move {
            storage
                .match_cache_entry(&query)
                .await
                .unwrap()
                .map(|found| (found.entry.key, found.match_type))
        }
    };

    assert_eq!(
        lookup(&["primary", "restore"], &[feature, SCOPE]).await,
        Some(("primary".to_owned(), MatchType::ExactPrimary)),
        "the first scope wins"
    );
    assert_eq!(
        lookup(&["primary", "restore"], &[SCOPE, feature]).await,
        Some(("primary-new".to_owned(), MatchType::PrefixedPrimary)),
        "the newest prefix of the primary key beats an exact restore key"
    );
    assert_eq!(
        lookup(&["missing", "restore"], &[SCOPE]).await,
        Some(("restore".to_owned(), MatchType::ExactRestore)),
        "an exact restore key beats a newer entry it prefixes"
    );
    assert_eq!(
        lookup(&["missing", "absent", "restore-"], &[SCOPE]).await,
        Some(("restore-newer".to_owned(), MatchType::PrefixedRestore)),
        "a later restore key matches by prefix"
    );
    assert_eq!(
        lookup(&["missing", "absent"], &[SCOPE, feature]).await,
        None,
        "no candidate matches"
    );
}
