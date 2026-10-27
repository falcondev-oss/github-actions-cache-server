//! Storage backends behind one interface.

use std::io;

use axum::body::Bytes;
use futures_util::stream::BoxStream;

use super::filesystem::FilesystemAdapter;
use super::object::ObjectAdapter;
use crate::config::StorageConfig;
use crate::error::{Failure, Result};

/// A stream of object bytes.
pub(crate) type ByteStream = BoxStream<'static, io::Result<Bytes>>;

/// What an upload writes, which decides how hard it may push object storage.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum UploadKind {
    /// A Part streamed by a client, with the length it announced; clients already upload many
    /// Parts at once.
    Part { length: Option<u64> },
    /// A Merge: one stream for the whole entry, which a first download waits on, with the
    /// length of its Parts.
    Merged { length: Option<u64> },
}

impl UploadKind {
    pub(crate) const fn length(self) -> Option<u64> {
        match self {
            Self::Part { length } | Self::Merged { length } => length,
        }
    }
}

pub(crate) use http_range_header::{EndPosition, StartPosition};

/// A requested byte range, resolved against the object length when it is read.
pub(crate) type RangeRequest = http_range_header::SyntacticallyCorrectRange;

/// An inclusive byte range that was actually served.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ByteRange {
    pub(crate) start: u64,
    pub(crate) end: u64,
}

impl ByteRange {
    pub(crate) const fn len(self) -> u64 {
        self.end.saturating_sub(self.start).saturating_add(1)
    }
}

/// Resolves a range against an object length; `None` when it starts past the end. A suffix longer
/// than the object covers all of it (RFC 9110 §14.1.2).
pub(crate) fn clamp_range(range: RangeRequest, size: u64) -> Option<ByteRange> {
    let last = size.checked_sub(1)?;
    let start = match range.start {
        StartPosition::Index(start) => start,
        StartPosition::FromLast(suffix) => size.saturating_sub(suffix),
    };
    let end = match range.end {
        EndPosition::Index(end) => end.min(last),
        EndPosition::LastByte => last,
    };
    (start <= end).then_some(ByteRange { start, end })
}

/// How much of an object a [`DownloadStream`] serves.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Extent {
    /// The whole object, of a length not known up front.
    Unsized,
    /// The whole object.
    Whole { size: u64 },
    /// A requested range that was honoured.
    Partial { range: ByteRange, size: u64 },
}

/// An object being read.
pub(crate) struct DownloadStream {
    pub(crate) stream: ByteStream,
    pub(crate) extent: Extent,
}

impl std::fmt::Debug for DownloadStream {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DownloadStream")
            .field("extent", &self.extent)
            .finish_non_exhaustive()
    }
}

#[derive(Debug, thiserror::Error)]
pub(crate) enum ReadError {
    #[error("object not found in storage: {0}")]
    NotFound(String),
    #[error("range not satisfiable for {0}")]
    RangeNotSatisfiable(String),
    #[error(transparent)]
    Failed(#[from] Failure),
}

/// A top-level folder with its aggregated contents.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct StorageFolder {
    pub(crate) folder_name: String,
    pub(crate) object_count: u64,
    pub(crate) bytes: u64,
    /// Newest modification time in milliseconds since the Unix epoch.
    pub(crate) updated_at: i64,
}

impl StorageFolder {
    pub(crate) const fn empty(folder_name: String) -> Self {
        Self {
            folder_name,
            object_count: 0,
            bytes: 0,
            updated_at: 0,
        }
    }

    pub(crate) fn add(&mut self, bytes: u64, updated_at: i64) {
        self.object_count = self.object_count.saturating_add(1);
        self.bytes = self.bytes.saturating_add(bytes);
        self.updated_at = self.updated_at.max(updated_at);
    }
}

/// Bytes reclaimed by a deletion.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct StorageDeletion {
    pub(crate) objects: u64,
    pub(crate) bytes: u64,
}

/// Capacity and occupancy of the volume holding filesystem storage.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct FilesystemUsage {
    pub(crate) capacity_bytes: u64,
    pub(crate) used_bytes: u64,
}

/// The configured storage backend.
///
/// Uploads must be atomically visible: an object never exists partially, and overwriting an
/// object never disturbs active readers of the previous version. Object stores give this
/// natively; the filesystem adapter writes to a temp path and renames. See ADR-0004.
#[derive(Debug)]
pub(crate) enum Adapter {
    Filesystem(FilesystemAdapter),
    Object(ObjectAdapter),
}

impl Adapter {
    pub(crate) async fn from_config(config: &StorageConfig) -> Result<Self> {
        match config {
            StorageConfig::Filesystem { path } => {
                Ok(Self::Filesystem(FilesystemAdapter::new(path).await?))
            }
            StorageConfig::S3 { .. } | StorageConfig::Gcs { .. } | StorageConfig::AzBlob { .. } => {
                Ok(Self::Object(ObjectAdapter::from_config(config).await?))
            }
        }
    }

    /// Object storage below a unique prefix, so tests can share one bucket.
    #[cfg(test)]
    pub(crate) async fn isolated(config: &StorageConfig, prefix: &str) -> Result<Self> {
        match config {
            StorageConfig::Filesystem { .. } => Self::from_config(config).await,
            StorageConfig::S3 { .. } | StorageConfig::Gcs { .. } | StorageConfig::AzBlob { .. } => {
                Ok(Self::Object(
                    ObjectAdapter::with_prefix(config, object_store::path::Path::from(prefix))
                        .await?,
                ))
            }
        }
    }

    pub(crate) async fn download_stream(
        &self,
        name: &str,
        range: Option<RangeRequest>,
    ) -> Result<DownloadStream, ReadError> {
        match self {
            Self::Filesystem(adapter) => adapter.download_stream(name, range).await,
            Self::Object(adapter) => adapter.download_stream(name, range).await,
        }
    }

    pub(crate) async fn upload_stream(
        &self,
        name: &str,
        stream: ByteStream,
        kind: UploadKind,
    ) -> Result<()> {
        match self {
            Self::Filesystem(adapter) => adapter.upload_stream(name, stream).await,
            Self::Object(adapter) => adapter.upload_stream(name, stream, kind).await,
        }
    }

    pub(crate) async fn object_exists(&self, name: &str) -> Result<bool> {
        match self {
            Self::Filesystem(adapter) => adapter.object_exists(name).await,
            Self::Object(adapter) => adapter.object_exists(name).await,
        }
    }

    pub(crate) async fn delete_folder(&self, folder: &str) -> Result<StorageDeletion> {
        match self {
            Self::Filesystem(adapter) => adapter.delete_folder(folder).await,
            Self::Object(adapter) => adapter.delete_folder(folder).await,
        }
    }

    /// Sizes of the objects under a folder.
    pub(crate) async fn list_folder(&self, folder: &str) -> Result<Vec<u64>> {
        match self {
            Self::Filesystem(adapter) => adapter.list_folder(folder).await,
            Self::Object(adapter) => adapter.list_folder(folder).await,
        }
    }

    pub(crate) async fn list_storage_folders(&self) -> Result<Vec<StorageFolder>> {
        match self {
            Self::Filesystem(adapter) => adapter.list_storage_folders().await,
            Self::Object(adapter) => adapter.list_storage_folders().await,
        }
    }

    /// Only meaningful for filesystem storage, whose Storage Budget follows the volume.
    pub(crate) fn filesystem_usage(&self) -> Option<Result<FilesystemUsage>> {
        match self {
            Self::Filesystem(adapter) => Some(adapter.usage()),
            Self::Object(_) => None,
        }
    }

    pub(crate) async fn clear(&self) -> Result<()> {
        match self {
            Self::Filesystem(adapter) => adapter.clear().await,
            Self::Object(adapter) => adapter.clear().await,
        }
    }
}

#[cfg(test)]
mod tests;
