use std::time::Duration;

use super::*;

const CHUNKS: usize = 24;

fn chunks() -> ByteStream {
    stream::iter((0..CHUNKS).map(|_| Ok(Bytes::from(vec![1_u8; 64 * 1024])))).boxed()
}

/// Drains a receiver, pausing after every chunk.
async fn consume(mut chunks: mpsc::Receiver<io::Result<Bytes>>, pause: Duration) -> usize {
    let mut total = 0_usize;
    while let Some(chunk) = chunks.recv().await {
        total = total.saturating_add(chunk.unwrap().len());
        tokio::time::sleep(pause).await;
    }
    total
}

// Regression for #247: sinks consumed at different rates must not deadlock the tee.
#[tokio::test]
async fn tees_parts_to_readers_of_different_speeds() {
    let (response, response_receiver) = mpsc::channel(1);
    let (merger, merger_receiver) = mpsc::channel(1);
    let pump = tokio::spawn(pump_parts(chunks(), response, merger));
    let slow = consume(response_receiver, Duration::from_millis(5));
    let fast = consume(merger_receiver, Duration::ZERO);
    let (slow, fast) =
        tokio::time::timeout(Duration::from_secs(5), async { tokio::join!(slow, fast) })
            .await
            .unwrap();
    pump.await.unwrap();
    assert_eq!(
        (slow, fast),
        (CHUNKS * 64 * 1024, CHUNKS * 64 * 1024),
        "both get every byte"
    );
}

#[tokio::test]
async fn a_merged_location_is_not_claimed_again() {
    let server = crate::tests::harness::TestServer::start().await;
    let db = server.db();
    let location = crate::tests::harness::save_parts(
        server.storage(),
        "merged",
        &[b"a".to_vec(), b"b".to_vec()],
    )
    .await;
    storage_locations::Entity::update_many()
        .set(storage_locations::ActiveModel {
            merged_at: Set(Some(now_ms())),
            ..Default::default()
        })
        .filter(storage_locations::COLUMN.id.eq(location.id.as_str()))
        .exec(&db.pool)
        .await
        .unwrap();

    assert_eq!(
        claim_merge(db, &location.id).await.unwrap(),
        None,
        "not claimed"
    );
    assert!(
        acquire_merge_lease(db, &location.id)
            .await
            .unwrap()
            .is_some(),
        "the lease was released"
    );
}

#[tokio::test]
async fn keeps_merging_after_the_client_goes_away() {
    let (response, response_receiver) = mpsc::channel(1);
    let (merger, merger_receiver) = mpsc::channel(1);
    drop(response_receiver);
    let pump = tokio::spawn(pump_parts(chunks(), response, merger));
    let merge_input = consume(merger_receiver, Duration::ZERO).await;
    pump.await.unwrap();
    assert_eq!(
        merge_input,
        CHUNKS * 64 * 1024,
        "the merge still gets every byte"
    );
}

#[tokio::test]
async fn skips_merges_beyond_the_cap() {
    use crate::tests::harness::{
        TestServer, eventually, find_location, insert_location, unmerged_location,
    };

    let server = TestServer::with(&[("MAX_CONCURRENT_MERGES", "1")]).await;
    let (storage, db) = (server.storage(), server.db());
    let [first, second] = [(); 2].map(|()| unmerged_location(&uuid::Uuid::new_v4().to_string()));
    for location in [&first, &second] {
        insert_location(db, location).await;
    }
    let (release, held) = tokio::sync::oneshot::channel::<()>();
    let write = async move {
        drop(held.await);
        Ok(())
    };
    assert!(
        storage.start_merge(&first, write.boxed()).await.unwrap(),
        "the first merge starts"
    );
    let done = || async { Ok(()) }.boxed();
    assert!(
        !storage.start_merge(&second, done()).await.unwrap(),
        "past the cap"
    );
    let skipped = find_location(db, &second.id).await.unwrap();
    assert_eq!(
        skipped.merge_started_at, None,
        "a skipped merge is not claimed"
    );

    release.send(()).unwrap();
    eventually(|| async {
        find_location(db, &first.id)
            .await
            .unwrap()
            .merged_at
            .is_some()
    })
    .await;
    // The slot is freed just after the merge completes.
    eventually(|| async { storage.merge_slots.available_permits() == 1 }).await;
    assert!(
        storage.start_merge(&second, done()).await.unwrap(),
        "a freed slot takes the next merge"
    );
}
