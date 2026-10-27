//! Block uploads (Azure Blob protocol subset) and cache downloads.

use std::io;

use axum::body::Body;
use axum::extract::rejection::PathRejection;
use axum::extract::{Path, Query, State};
use axum::http::header::{ACCEPT_RANGES, CONTENT_LENGTH, CONTENT_RANGE, RANGE};
use axum::http::{HeaderMap, HeaderName, HeaderValue, StatusCode};
use axum::response::{IntoResponse as _, Response};
use base64::Engine as _;
use base64::engine::general_purpose::{GeneralPurpose, GeneralPurposeConfig};
use base64::engine::{DecodePaddingMode, general_purpose};
use futures_util::{StreamExt as _, TryStreamExt as _};
use http_range_header::parse_range_header;
use serde::Deserialize;

use super::AppState;
use crate::http::HttpError;
use crate::storage::{DownloadError, EndPosition, Extent, RangeRequest, StartPosition};

/// Clients without a request id intermittently fail with EOF (tonistiigi/go-actions-cache).
const REQUEST_ID: HeaderName = HeaderName::from_static("x-ms-request-id");

/// Lenient like Node's `Buffer.from(value, 'base64')`.
const BASE64: GeneralPurpose = GeneralPurpose::new(
    &base64::alphabet::STANDARD,
    GeneralPurposeConfig::new().with_decode_padding_mode(DecodePaddingMode::Indifferent),
);

fn created() -> Response {
    let request_id = HeaderValue::from_str(&uuid::Uuid::new_v4().to_string());
    match request_id {
        Ok(request_id) => (StatusCode::CREATED, [(REQUEST_ID, request_id)]).into_response(),
        Err(_invalid) => StatusCode::CREATED.into_response(),
    }
}

/// Extracts the part index from an Azure block id.
fn chunk_index(block_id: &str) -> Option<u32> {
    let decoded = BASE64
        .decode(block_id.trim_end_matches('='))
        .or_else(|_standard| {
            general_purpose::URL_SAFE_NO_PAD.decode(block_id.trim_end_matches('='))
        })
        .ok()?;
    match decoded.len() {
        // docker buildx: a big-endian index at byte 16
        64 => decoded.get(16..20)?.try_into().ok().map(u32::from_be_bytes),
        // everything else: a 36 character uuid followed by the index
        48 => {
            let suffix = String::from_utf8_lossy(decoded.get(36..)?).into_owned();
            let digits: String = suffix
                .trim_start()
                .chars()
                .take_while(char::is_ascii_digit)
                .collect();
            digits.parse().ok()
        }
        _ => None,
    }
}

/// Query of an Azure `Put Block` / `Put Block List` request.
#[derive(Debug, Deserialize)]
pub(super) struct BlockQuery {
    comp: Option<String>,
    blockid: Option<String>,
}

pub(super) async fn upload(
    State(state): State<AppState>,
    upload_id: Result<Path<i64>, PathRejection>,
    Query(query): Query<BlockQuery>,
    headers: HeaderMap,
    body: Body,
) -> Result<Response, HttpError> {
    let Path(upload_id) = upload_id.map_err(|_rejection| {
        HttpError::bad_request("Invalid path parameters: uploadId must be a number")
    })?;
    if query.comp.as_deref() == Some("blocklist") {
        return Ok(created());
    }
    // no block id: an upload smaller than the chunk size
    let index = match &query.blockid {
        Some(block_id) => chunk_index(block_id)
            .ok_or_else(|| HttpError::bad_request(format!("Invalid block id: {block_id}")))?,
        None => 0,
    };
    // Streamed straight into storage, so the client is paced by how fast storage accepts it.
    let length = headers
        .get(CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok()?.parse().ok());
    let stream = body.into_data_stream().map_err(io::Error::other).boxed();
    if !state
        .storage
        .upload_part(upload_id, index, stream, length)
        .await?
    {
        return Err(HttpError::new(
            StatusCode::NOT_FOUND,
            format!("Upload not found: {upload_id}"),
        ));
    }
    Ok(created())
}

/// A single range; multi-range requests and invalid headers, which includes inverted ranges, are
/// served whole.
fn parse_range(headers: &HeaderMap) -> Option<RangeRequest> {
    let parsed = parse_range_header(headers.get(RANGE)?.to_str().ok()?).ok()?;
    let &[range] = parsed.ranges.as_slice() else {
        return None;
    };
    let inverted = matches!(
        (range.start, range.end),
        (StartPosition::Index(start), EndPosition::Index(end)) if end < start
    );
    (!inverted).then_some(range)
}

pub(super) async fn download(
    State(state): State<AppState>,
    Path(location_id): Path<String>,
    headers: HeaderMap,
) -> Result<Response, HttpError> {
    let range = parse_range(&headers);
    // Unmerged entries ignore Range, so clients must key off the status, not this header.
    let accept_ranges = (ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    let download = match state.storage.download(&location_id, range).await {
        Ok(Some(download)) => download,
        Ok(None) => {
            return Err(HttpError::new(
                StatusCode::NOT_FOUND,
                "Cache file not found",
            ));
        }
        Err(DownloadError::RangeNotSatisfiable { size }) => {
            let mut response = (StatusCode::RANGE_NOT_SATISFIABLE, [accept_ranges]).into_response();
            if let Some(content_range) =
                size.and_then(|size| HeaderValue::from_str(&format!("bytes */{size}")).ok())
            {
                response.headers_mut().insert(CONTENT_RANGE, content_range);
            }
            return Ok(response);
        }
        Err(DownloadError::Failed(failure)) => return Err(failure.into()),
    };

    let mut response = Response::new(Body::from_stream(download.stream));
    let response_headers = response.headers_mut();
    response_headers.insert(accept_ranges.0, accept_ranges.1);
    match download.extent {
        Extent::Partial {
            range: served,
            size,
        } => {
            if let Ok(content_range) =
                HeaderValue::from_str(&format!("bytes {}-{}/{size}", served.start, served.end))
            {
                response_headers.insert(CONTENT_RANGE, content_range);
            }
            response_headers.insert(CONTENT_LENGTH, HeaderValue::from(served.len()));
            *response.status_mut() = StatusCode::PARTIAL_CONTENT;
        }
        Extent::Whole { size } => {
            response_headers.insert(CONTENT_LENGTH, HeaderValue::from(size));
        }
        Extent::Unsized => {}
    }
    Ok(response)
}

#[cfg(test)]
mod tests;
