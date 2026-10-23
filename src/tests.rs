//! Tests against live servers over the backend selected by `TEST_DB_DRIVER` (sqlite, postgres,
//! mysql) and `TEST_STORAGE_DRIVER` (filesystem, s3, gcs, azblob).

mod cache_protocol;
mod cleanup;
mod downloads;
pub(crate) mod harness;
mod management;
mod passthrough;
mod reservations;
mod storage_backends;
