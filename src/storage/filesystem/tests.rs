use futures_util::stream;

use super::*;

async fn adapter() -> (tempfile::TempDir, FilesystemAdapter) {
    let dir = tempfile::tempdir().unwrap();
    let adapter = FilesystemAdapter::new(dir.path()).await.unwrap();
    (dir, adapter)
}

fn bytes(chunks: &[&'static [u8]]) -> ByteStream {
    let chunks: Vec<_> = chunks
        .iter()
        .map(|chunk| Ok(axum::body::Bytes::from_static(chunk)))
        .collect();
    stream::iter(chunks).boxed()
}

async fn read_all(stream: ByteStream) -> Vec<u8> {
    stream
        .map_ok(|chunk| chunk.to_vec())
        .try_concat()
        .await
        .unwrap()
}

#[tokio::test]
async fn rejects_names_escaping_the_root() {
    let (_dir, adapter) = adapter().await;
    assert!(adapter.safe_path("../outside").is_err(), "parent escape");
    assert!(adapter.safe_path("/etc/passwd").is_err(), "absolute path");
    assert!(adapter.safe_path("a/../b").is_ok(), "stays inside");
}

#[tokio::test]
async fn uploads_atomically_and_serves_ranges() {
    let (_dir, adapter) = adapter().await;
    adapter
        .upload_stream("f/parts/0", bytes(&[b"hello ", b"world"]))
        .await
        .unwrap();

    let whole = adapter.download_stream("f/parts/0", None).await.unwrap();
    assert_eq!(whole.extent, Extent::Whole { size: 11 }, "size is reported");
    assert_eq!(read_all(whole.stream).await, b"hello world", "whole object");

    let range = RangeRequest {
        start: 6,
        end: Some(100),
    };
    let ranged = adapter
        .download_stream("f/parts/0", Some(range))
        .await
        .unwrap();
    assert_eq!(read_all(ranged.stream).await, b"world", "clamped range");

    let past = RangeRequest {
        start: 11,
        end: None,
    };
    assert!(
        matches!(
            adapter.download_stream("f/parts/0", Some(past)).await,
            Err(ReadError::RangeNotSatisfiable(_))
        ),
        "range past the end"
    );
    let interrupted = stream::iter([
        Ok(axum::body::Bytes::from_static(b"partial")),
        Err(io::Error::other("interrupted upload")),
    ])
    .boxed();
    assert!(
        adapter
            .upload_stream("f/parts/1", interrupted)
            .await
            .is_err(),
        "upload fails"
    );
    assert!(
        !adapter.object_exists("f/parts/1").await.unwrap(),
        "a failed upload is invisible"
    );
    let folders = adapter.list_storage_folders().await.unwrap();
    assert_eq!(folders.len(), 1, "no temp entry is left behind");
}

#[tokio::test]
async fn deletes_folders_and_top_level_files() {
    let (dir, adapter) = adapter().await;
    adapter
        .upload_stream("f/parts/0", bytes(&[b"abc"]))
        .await
        .unwrap();
    adapter
        .upload_stream("f/parts/1", bytes(&[b"de"]))
        .await
        .unwrap();
    std::fs::write(dir.path().join("tmp-stale"), b"x").unwrap();

    let deleted = adapter.delete_folder("f").await.unwrap();
    assert_eq!(
        deleted,
        StorageDeletion {
            objects: 2,
            bytes: 5
        },
        "reclaimed bytes"
    );
    let file = adapter.delete_folder("tmp-stale").await.unwrap();
    assert_eq!(
        file,
        StorageDeletion {
            objects: 1,
            bytes: 1
        },
        "top-level temp file"
    );
    assert!(
        adapter.list_storage_folders().await.unwrap().is_empty(),
        "nothing left"
    );
    assert_eq!(
        adapter.delete_folder("missing").await.unwrap(),
        StorageDeletion::default(),
        "missing folder"
    );
}
