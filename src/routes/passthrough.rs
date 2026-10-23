//! Results Passthrough: requests the server does not handle go to the Default Results Origin.

use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::header::{
    ACCEPT_ENCODING, CONNECTION, EXPECT, HOST, PROXY_AUTHENTICATE, PROXY_AUTHORIZATION, TE,
    TRAILER, TRANSFER_ENCODING, UPGRADE,
};
use axum::http::{HeaderMap, HeaderName, StatusCode};
use axum::response::Response;
use futures_util::TryStreamExt as _;

use super::AppState;
use crate::http::HttpError;

/// Hop-by-hop headers, plus what the outgoing connection sets for itself.
fn is_connection_specific(name: &HeaderName) -> bool {
    [
        CONNECTION,
        TE,
        TRAILER,
        TRANSFER_ENCODING,
        UPGRADE,
        PROXY_AUTHENTICATE,
        PROXY_AUTHORIZATION,
        HOST,
        EXPECT,
    ]
    .contains(name)
        || name.as_str() == "keep-alive"
}

fn forwardable(headers: &HeaderMap) -> HeaderMap {
    headers
        .iter()
        .filter(|(name, _)| !is_connection_specific(name))
        .map(|(name, value)| (name.clone(), value.clone()))
        .collect()
}

pub(super) async fn forward(
    State(state): State<AppState>,
    request: Request,
) -> Result<Response, HttpError> {
    let (parts, body) = request.into_parts();
    let path = parts.uri.path_and_query().map_or("/", |path| path.as_str());
    let url = format!("{}{path}", state.config.default_actions_results_url);
    tracing::debug!(path, url, "proxying unknown path");

    let mut headers = forwardable(&parts.headers);
    // Leaving the encoding to the origin's default keeps the body byte-for-byte passthrough.
    headers.remove(ACCEPT_ENCODING);
    let upstream = state
        .http
        .request(parts.method, url)
        .headers(headers)
        .body(reqwest::Body::wrap_stream(body.into_data_stream()))
        .send()
        .await
        .map_err(|error| {
            tracing::warn!(%error, "Results Passthrough failed");
            HttpError::new(StatusCode::BAD_GATEWAY, "Bad Gateway")
        })?;

    let mut response = Response::builder().status(upstream.status());
    if let Some(response_headers) = response.headers_mut() {
        *response_headers = forwardable(upstream.headers());
    }
    response
        .body(Body::from_stream(
            upstream.bytes_stream().map_err(std::io::Error::other),
        ))
        .map_err(|error| HttpError::new(StatusCode::BAD_GATEWAY, error.to_string()))
}
