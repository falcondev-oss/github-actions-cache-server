//! Twirp `CacheService` handlers and the metrics endpoint.

use axum::body::Bytes;
use axum::extract::State;
use axum::http::header::CONTENT_TYPE;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse as _, Response};
use serde_json::json;

use super::AppState;
use crate::http::HttpError;
use crate::metrics::LookupResult;
use crate::scope::{CacheScope, Unauthorized};
use crate::storage::{CacheQuery, CreatedUpload, EntryIdentity};
use crate::twirp::{self, Format};

impl From<Unauthorized> for HttpError {
    fn from(unauthorized: Unauthorized) -> Self {
        Self::new(StatusCode::UNAUTHORIZED, unauthorized.0)
    }
}

/// The identity a save writes under: the token's first writable scope.
fn save_identity(
    scope: &CacheScope,
    key: String,
    version: String,
) -> Result<EntryIdentity, HttpError> {
    let write_scope = scope.write_scope().ok_or_else(|| {
        HttpError::new(
            StatusCode::FORBIDDEN,
            "No scope with write permission found",
        )
    })?;
    Ok(EntryIdentity {
        key,
        version,
        scope: write_scope.scope.clone(),
        repo_id: scope.repo_id.clone(),
    })
}

pub(super) async fn create_cache_entry(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, HttpError> {
    let scope = state.verifier.cache_scope(&headers).await?;
    let format = Format::of(&headers);
    let request: twirp::CreateCacheEntryRequest = twirp::decode(format, &body)?;
    let identity = save_identity(&scope, request.key, request.version)?;
    match state.storage.create_upload(&identity).await? {
        CreatedUpload::Created { id } => Ok(twirp::respond(
            format,
            &twirp::CreateCacheEntryResponse {
                ok: true,
                signed_upload_url: format!(
                    "{}/devstoreaccount1/upload/{id}",
                    state.config.api_base_url
                ),
                message: String::new(),
            },
        )),
        // GitHub answers a duplicate reservation with 409 already_exists, not 200 with ok: false.
        CreatedUpload::AlreadyExists => Ok((
            StatusCode::CONFLICT,
            axum::Json(json!({
                "code": "already_exists",
                "msg": "cache entry with the same key, version, and scope already exists",
            })),
        )
            .into_response()),
    }
}

pub(super) async fn finalize_cache_entry_upload(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, HttpError> {
    let scope = state.verifier.cache_scope(&headers).await?;
    let format = Format::of(&headers);
    let request: twirp::FinalizeCacheEntryUploadRequest = twirp::decode(format, &body)?;
    let identity = save_identity(&scope, request.key, request.version)?;
    let upload = state
        .storage
        .complete_upload(&identity)
        .await?
        .ok_or_else(|| HttpError::new(StatusCode::NOT_FOUND, "Upload not found"))?;
    state.metrics.record_upload();
    Ok(twirp::respond(
        format,
        &twirp::FinalizeCacheEntryUploadResponse {
            ok: true,
            entry_id: upload.id,
            message: String::new(),
        },
    ))
}

pub(super) async fn get_cache_entry_download_url(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, HttpError> {
    let scope = state.verifier.cache_scope(&headers).await?;
    let format = Format::of(&headers);
    let request: twirp::GetCacheEntryDownloadUrlRequest = twirp::decode(format, &body)?;
    let query = CacheQuery {
        primary_key: request.key,
        restore_keys: request.restore_keys,
        version: request.version,
        scopes: scope.read_scopes(),
        repo_id: scope.repo_id.clone(),
    };
    let matched = state.storage.cache_entry_with_download_url(&query).await?;
    state.metrics.record_lookup(if matched.is_some() {
        LookupResult::Hit
    } else {
        LookupResult::Miss
    });
    let response = matched.map_or_else(Default::default, |matched| {
        twirp::GetCacheEntryDownloadUrlResponse {
            ok: true,
            signed_download_url: matched.download_url,
            matched_key: matched.entry.key,
        }
    });
    Ok(twirp::respond(format, &response))
}

pub(super) async fn metrics(State(state): State<AppState>) -> Result<Response, HttpError> {
    let body = state.metrics.render(&state.storage.db).await?;
    Ok(([(CONTENT_TYPE, prometheus::TEXT_FORMAT)], body).into_response())
}
