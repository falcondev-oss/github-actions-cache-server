//! Twirp `CacheService` messages, in JSON or protobuf as the client negotiates.
//!
//! Only the fields the server reads or writes are declared; unknown fields (e.g. `metadata`) are
//! skipped on decode.

use std::fmt::Display;

use axum::body::Bytes;
use axum::http::header::CONTENT_TYPE;
use axum::http::{HeaderMap, HeaderValue};
use axum::response::{IntoResponse as _, Response};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use crate::http::HttpError;

const PROTOBUF_CONTENT_TYPE: &str = "application/protobuf";

/// Wire format of a Twirp exchange. A protobuf request must get a protobuf response; anything not
/// explicitly protobuf is JSON, the format of the GitHub runner's JSON-only client.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Format {
    Json,
    Protobuf,
}

impl Format {
    pub(crate) fn of(headers: &HeaderMap) -> Self {
        let protobuf = headers
            .get(CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.contains(PROTOBUF_CONTENT_TYPE));
        if protobuf { Self::Protobuf } else { Self::Json }
    }
}

fn null_as_empty<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Vec<String>, D::Error> {
    Ok(Option::<Vec<String>>::deserialize(deserializer)?.unwrap_or_default())
}

#[derive(Clone, PartialEq, Eq, prost::Message, Deserialize)]
pub(crate) struct CreateCacheEntryRequest {
    #[prost(string, tag = "2")]
    #[serde(default)]
    pub(crate) key: String,
    #[prost(string, tag = "3")]
    #[serde(default)]
    pub(crate) version: String,
}

#[derive(Clone, PartialEq, Eq, prost::Message, Serialize)]
pub(crate) struct CreateCacheEntryResponse {
    #[prost(bool, tag = "1")]
    pub(crate) ok: bool,
    #[prost(string, tag = "2")]
    pub(crate) signed_upload_url: String,
    #[prost(string, tag = "3")]
    #[serde(skip_serializing_if = "String::is_empty")]
    pub(crate) message: String,
}

#[derive(Clone, PartialEq, Eq, prost::Message, Deserialize)]
pub(crate) struct FinalizeCacheEntryUploadRequest {
    #[prost(string, tag = "2")]
    #[serde(default)]
    pub(crate) key: String,
    /// Not read; JSON clients send it as a string or a number.
    #[prost(int64, tag = "3")]
    #[serde(skip)]
    pub(crate) size_bytes: i64,
    #[prost(string, tag = "4")]
    #[serde(default)]
    pub(crate) version: String,
}

#[derive(Clone, PartialEq, Eq, prost::Message, Serialize)]
pub(crate) struct FinalizeCacheEntryUploadResponse {
    #[prost(bool, tag = "1")]
    pub(crate) ok: bool,
    /// JSON carries 64-bit integers as strings.
    #[prost(int64, tag = "2")]
    #[serde(serialize_with = "serialize_display")]
    pub(crate) entry_id: i64,
    #[prost(string, tag = "3")]
    #[serde(skip_serializing_if = "String::is_empty")]
    pub(crate) message: String,
}

#[derive(Clone, PartialEq, Eq, prost::Message, Deserialize)]
pub(crate) struct GetCacheEntryDownloadUrlRequest {
    #[prost(string, tag = "2")]
    #[serde(default)]
    pub(crate) key: String,
    #[prost(string, repeated, tag = "3")]
    #[serde(default, deserialize_with = "null_as_empty")]
    pub(crate) restore_keys: Vec<String>,
    #[prost(string, tag = "4")]
    #[serde(default)]
    pub(crate) version: String,
}

#[derive(Clone, PartialEq, Eq, prost::Message, Serialize)]
pub(crate) struct GetCacheEntryDownloadUrlResponse {
    #[prost(bool, tag = "1")]
    pub(crate) ok: bool,
    #[prost(string, tag = "2")]
    #[serde(skip_serializing_if = "String::is_empty")]
    pub(crate) signed_download_url: String,
    #[prost(string, tag = "3")]
    #[serde(skip_serializing_if = "String::is_empty")]
    pub(crate) matched_key: String,
}

fn serialize_display<S: serde::Serializer>(
    value: &impl Display,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    serializer.collect_str(value)
}

fn invalid(reason: impl Display) -> HttpError {
    HttpError::bad_request(format!("Invalid body: {reason}"))
}

/// A request naming a cache entry; both fields must be non-empty.
pub(crate) trait Keyed: prost::Message + Default + DeserializeOwned {
    fn key_and_version(&self) -> [&str; 2];
}

impl Keyed for CreateCacheEntryRequest {
    fn key_and_version(&self) -> [&str; 2] {
        [&self.key, &self.version]
    }
}

impl Keyed for FinalizeCacheEntryUploadRequest {
    fn key_and_version(&self) -> [&str; 2] {
        [&self.key, &self.version]
    }
}

impl Keyed for GetCacheEntryDownloadUrlRequest {
    fn key_and_version(&self) -> [&str; 2] {
        [&self.key, &self.version]
    }
}

/// Decodes a request, rejecting the empty `key` or `version` an omitted field decodes to.
pub(crate) fn decode<T: Keyed>(format: Format, body: &Bytes) -> Result<T, HttpError> {
    let request: T = match format {
        Format::Protobuf => T::decode(body.as_ref()).map_err(invalid)?,
        Format::Json => serde_json::from_slice(body).map_err(invalid)?,
    };
    if request
        .key_and_version()
        .iter()
        .any(|field| field.is_empty())
    {
        return Err(invalid("key and version must be non-empty strings"));
    }
    Ok(request)
}

/// Answers in the request's format.
pub(crate) fn respond(format: Format, message: &(impl prost::Message + Serialize)) -> Response {
    match format {
        Format::Json => axum::Json(message).into_response(),
        Format::Protobuf => (
            [(
                CONTENT_TYPE,
                HeaderValue::from_static(PROTOBUF_CONTENT_TYPE),
            )],
            message.encode_to_vec(),
        )
            .into_response(),
    }
}
