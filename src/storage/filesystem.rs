//! Storage on a local (or mounted) filesystem.

use std::io::{self, SeekFrom};
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

use futures_util::{StreamExt as _, TryStreamExt as _};
use tokio::fs;
use tokio::io::{AsyncReadExt as _, AsyncSeekExt as _, AsyncWriteExt as _};
use tokio_util::io::ReaderStream;

use super::adapter::{
    ByteStream, DownloadStream, FilesystemUsage, RangeRequest, ReadError, StorageDeletion,
    StorageFolder, StorageObject, clamp_range,
};
use crate::error::{Failure, Result};

const READ_CHUNK_BYTES: usize = 64 * 1024;

#[derive(Debug)]
pub(crate) struct FilesystemAdapter {
    root: PathBuf,
}

fn is_not_found(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::NotFound
}

fn modified_ms(metadata: &std::fs::Metadata) -> io::Result<i64> {
    let modified = metadata
        .modified()?
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    Ok(i64::try_from(modified.as_millis()).unwrap_or(i64::MAX))
}

impl FilesystemAdapter {
    pub(crate) async fn new(root: &Path) -> Result<Self> {
        let root = std::path::absolute(root)?;
        fs::create_dir_all(&root).await?;
        Ok(Self { root })
    }

    /// Resolves an object name below the root, rejecting names that escape it.
    fn safe_path(&self, name: &str) -> Result<PathBuf> {
        let mut resolved = self.root.clone();
        for component in Path::new(name).components() {
            match component {
                Component::Normal(part) => resolved.push(part),
                Component::ParentDir => {
                    resolved.pop();
                }
                Component::CurDir => {}
                Component::RootDir | Component::Prefix(_) => {
                    return Err(Failure::msg("invalid object name"));
                }
            }
        }
        if resolved.starts_with(&self.root) {
            Ok(resolved)
        } else {
            Err(Failure::msg("invalid object name"))
        }
    }

    async fn inspect(&self, folder_name: &str) -> Result<StorageFolder> {
        let mut folder = StorageFolder::empty(folder_name.to_owned());
        let mut pending = vec![self.safe_path(folder_name)?];
        while let Some(path) = pending.pop() {
            let metadata = match fs::symlink_metadata(&path).await {
                Ok(metadata) => metadata,
                Err(error) if is_not_found(&error) => continue,
                Err(error) => return Err(error.into()),
            };
            if metadata.is_symlink() {
                return Err(Failure::msg(format!(
                    "refusing to inspect symbolic link in owned storage: {}",
                    path.display()
                )));
            }
            if metadata.is_dir() {
                folder.updated_at = folder.updated_at.max(modified_ms(&metadata)?);
                let mut entries = fs::read_dir(&path).await?;
                while let Some(entry) = entries.next_entry().await? {
                    pending.push(entry.path());
                }
            } else {
                folder.add(metadata.len(), modified_ms(&metadata)?);
            }
        }
        Ok(folder)
    }

    pub(crate) async fn download_stream(
        &self,
        name: &str,
        range: Option<RangeRequest>,
    ) -> Result<DownloadStream, ReadError> {
        let path = self.safe_path(name)?;
        let (mut file, size) = match fs::File::open(&path).await {
            Ok(file) => {
                let size = file.metadata().await.map_err(Failure::from)?.len();
                (file, size)
            }
            Err(error) if is_not_found(&error) => return Err(ReadError::NotFound(name.to_owned())),
            Err(error) => return Err(Failure::from(error).into()),
        };
        let Some(range) = range else {
            return Ok(DownloadStream {
                stream: ReaderStream::with_capacity(file, READ_CHUNK_BYTES).boxed(),
                size: Some(size),
                range: None,
            });
        };
        let served = clamp_range(range, size)
            .ok_or_else(|| ReadError::RangeNotSatisfiable(name.to_owned()))?;
        file.seek(SeekFrom::Start(served.start))
            .await
            .map_err(Failure::from)?;
        Ok(DownloadStream {
            stream: ReaderStream::with_capacity(file.take(served.len()), READ_CHUNK_BYTES).boxed(),
            size: Some(size),
            range: Some(served),
        })
    }

    pub(crate) async fn upload_stream(&self, name: &str, mut stream: ByteStream) -> Result<()> {
        let path = self.safe_path(name)?;
        // Write to a top-level temp entry and rename for atomic visibility. Temp entries orphaned
        // by a crash are unauthorized top-level storage, so orphaned storage cleanup reclaims them
        // after the grace period. Each upload gets its own entry; a shared temp directory would
        // stay perpetually fresh and never age out.
        let temp = self.safe_path(&format!("tmp-{}", uuid::Uuid::new_v4()))?;
        let written: Result<()> = async {
            let mut file = fs::File::create(&temp).await?;
            while let Some(chunk) = stream.try_next().await? {
                file.write_all(&chunk).await?;
            }
            file.flush().await?;
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).await?;
            }
            fs::rename(&temp, &path).await?;
            Ok(())
        }
        .await;
        if written.is_err() {
            match fs::remove_file(&temp).await {
                Err(error) if !is_not_found(&error) => {
                    tracing::warn!(path = %temp.display(), %error, "failed to remove temp file");
                }
                Ok(()) | Err(_) => {}
            }
        }
        written
    }

    pub(crate) async fn object_exists(&self, name: &str) -> Result<bool> {
        Ok(fs::try_exists(self.safe_path(name)?).await?)
    }

    pub(crate) async fn delete_folder(&self, folder: &str) -> Result<StorageDeletion> {
        let inspected = self.inspect(folder).await?;
        let path = self.safe_path(folder)?;
        let removed = match fs::symlink_metadata(&path).await {
            Ok(metadata) if metadata.is_dir() => fs::remove_dir_all(&path).await,
            Ok(_) => fs::remove_file(&path).await,
            Err(error) => Err(error),
        };
        match removed {
            Err(error) if !is_not_found(&error) => return Err(error.into()),
            Ok(()) | Err(_) => {}
        }
        Ok(StorageDeletion {
            objects: inspected.object_count,
            bytes: inspected.bytes,
        })
    }

    pub(crate) async fn list_folder(&self, folder: &str) -> Result<Vec<StorageObject>> {
        let mut entries = match fs::read_dir(self.safe_path(folder)?).await {
            Ok(entries) => entries,
            Err(error) if is_not_found(&error) => return Ok(Vec::new()),
            Err(error) => return Err(error.into()),
        };
        let mut objects = Vec::new();
        while let Some(entry) = entries.next_entry().await? {
            if entry.file_type().await?.is_dir() {
                continue;
            }
            objects.push(StorageObject {
                name: entry.file_name().to_string_lossy().into_owned(),
                bytes: fs::metadata(entry.path()).await?.len(),
            });
        }
        Ok(objects)
    }

    pub(crate) async fn list_storage_folders(&self) -> Result<Vec<StorageFolder>> {
        let mut entries = fs::read_dir(&self.root).await?;
        let mut folders = Vec::new();
        while let Some(entry) = entries.next_entry().await? {
            folders.push(self.inspect(&entry.file_name().to_string_lossy()).await?);
        }
        Ok(folders)
    }

    pub(crate) fn usage(&self) -> Result<FilesystemUsage> {
        let stats = rustix::fs::statvfs(&self.root).map_err(io::Error::from)?;
        let block = stats.f_frsize;
        Ok(FilesystemUsage {
            capacity_bytes: stats.f_blocks.saturating_mul(block),
            used_bytes: stats
                .f_blocks
                .saturating_sub(stats.f_bavail)
                .saturating_mul(block),
        })
    }

    pub(crate) async fn clear(&self) -> Result<()> {
        match fs::remove_dir_all(&self.root).await {
            Err(error) if !is_not_found(&error) => return Err(error.into()),
            Ok(()) | Err(_) => {}
        }
        fs::create_dir_all(&self.root).await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
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
        assert_eq!(whole.size, Some(11), "size is reported");
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
}
