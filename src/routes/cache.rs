//! Twirp `CacheService` handlers and the metrics endpoint.

use axum::extract::State;
use axum::http::header::CONTENT_TYPE;
use axum::response::{IntoResponse as _, Response};
use twirp::{Request, TwirpErrorResponse};

use super::AppState;
use crate::error::Failure;
use crate::http::HttpError;
use crate::metrics::LookupResult;
use crate::scope::{CacheScope, Unauthorized};
use crate::storage::{CacheQuery, CreatedUpload, EntryIdentity};
use crate::twirp::{
    CreateCacheEntryRequest, CreateCacheEntryResponse, FinalizeCacheEntryUploadRequest,
    FinalizeCacheEntryUploadResponse, GetCacheEntryDownloadUrlRequest,
    GetCacheEntryDownloadUrlResponse,
};

/// Serves the Twirp `CacheService`.
#[derive(Debug, Clone)]
pub(super) struct CacheService(pub(super) AppState);

impl From<Unauthorized> for TwirpErrorResponse {
    fn from(unauthorized: Unauthorized) -> Self {
        twirp::unauthenticated(unauthorized.0)
    }
}

impl From<Failure> for TwirpErrorResponse {
    fn from(failure: Failure) -> Self {
        tracing::error!(error = %failure, "request failed");
        twirp::internal("Internal Server Error")
    }
}

/// The identity a save writes under: the token's first writable scope.
fn save_identity(scope: &CacheScope, key: String, version: String) -> twirp::Result<EntryIdentity> {
    let write_scope = scope
        .write_scope()
        .ok_or_else(|| twirp::permission_denied("No scope with write permission found"))?;
    Ok(EntryIdentity {
        key: non_empty(key)?,
        version: non_empty(version)?,
        scope: write_scope.scope.clone(),
        repo_id: scope.repo_id.clone(),
    })
}

/// Rejects the empty `key` or `version` an omitted field decodes to.
fn non_empty(field: String) -> twirp::Result<String> {
    if field.is_empty() {
        return Err(twirp::invalid_argument(
            "key and version must be non-empty strings",
        ));
    }
    Ok(field)
}

#[twirp::async_trait::async_trait]
impl crate::twirp::CacheService for CacheService {
    async fn create_cache_entry(
        &self,
        req: Request<CreateCacheEntryRequest>,
    ) -> twirp::Result<twirp::Response<CreateCacheEntryResponse>> {
        let Self(state) = self;
        let scope = state.verifier.cache_scope(req.headers()).await?;
        let CreateCacheEntryRequest { key, version } = req.into_body();
        let identity = save_identity(&scope, key, version)?;
        match state.storage.create_upload(&identity).await? {
            CreatedUpload::Created { id } => Ok(twirp::Response::new(CreateCacheEntryResponse {
                ok: true,
                signed_upload_url: format!(
                    "{}/devstoreaccount1/upload/{id}",
                    state.config.api_base_url
                ),
                message: String::new(),
            })),
            // GitHub answers a duplicate reservation with 409, not 200 with ok: false.
            CreatedUpload::AlreadyExists => Err(twirp::already_exists(
                "cache entry with the same key, version, and scope already exists",
            )),
        }
    }

    async fn finalize_cache_entry_upload(
        &self,
        req: Request<FinalizeCacheEntryUploadRequest>,
    ) -> twirp::Result<twirp::Response<FinalizeCacheEntryUploadResponse>> {
        let Self(state) = self;
        let scope = state.verifier.cache_scope(req.headers()).await?;
        let FinalizeCacheEntryUploadRequest { key, version, .. } = req.into_body();
        let identity = save_identity(&scope, key, version)?;
        let upload = state
            .storage
            .complete_upload(&identity)
            .await?
            .ok_or_else(|| twirp::not_found("Upload not found"))?;
        state.metrics.record_upload();
        Ok(twirp::Response::new(FinalizeCacheEntryUploadResponse {
            ok: true,
            entry_id: upload.id,
            message: String::new(),
        }))
    }

    async fn get_cache_entry_download_url(
        &self,
        req: Request<GetCacheEntryDownloadUrlRequest>,
    ) -> twirp::Result<twirp::Response<GetCacheEntryDownloadUrlResponse>> {
        let Self(state) = self;
        let scope = state.verifier.cache_scope(req.headers()).await?;
        let GetCacheEntryDownloadUrlRequest {
            key,
            restore_keys,
            version,
        } = req.into_body();
        let query = CacheQuery {
            primary_key: non_empty(key)?,
            restore_keys,
            version: non_empty(version)?,
            scopes: scope.read_scopes(),
            repo_id: scope.repo_id.clone(),
        };
        let matched = state.storage.cache_entry_with_download_url(&query).await?;
        state.metrics.record_lookup(if matched.is_some() {
            LookupResult::Hit
        } else {
            LookupResult::Miss
        });
        Ok(twirp::Response::new(matched.map_or_else(
            Default::default,
            |matched| GetCacheEntryDownloadUrlResponse {
                ok: true,
                signed_download_url: matched.download_url,
                matched_key: matched.entry.key,
            },
        )))
    }
}

pub(super) async fn metrics(State(state): State<AppState>) -> Result<Response, HttpError> {
    let body = state.metrics.render(&state.storage.db).await?;
    Ok(([(CONTENT_TYPE, prometheus::TEXT_FORMAT)], body).into_response())
}
