//! HTTP routes and the state they share.

mod cache;
mod management;
mod passthrough;
mod transfer;

use std::sync::Arc;

use axum::Router;
use axum::routing::{any, post, put};

use crate::cleanup::Cleanup;
use crate::config::Config;
use crate::http::log_requests;
use crate::metrics::Metrics;
use crate::scope::TokenVerifier;
use crate::storage::Storage;

/// Everything a request handler can reach.
#[derive(Debug, Clone)]
pub(crate) struct AppState {
    pub(crate) config: Arc<Config>,
    pub(crate) storage: Arc<Storage>,
    pub(crate) verifier: Arc<TokenVerifier>,
    pub(crate) metrics: Arc<Metrics>,
    pub(crate) cleanup: Arc<Cleanup>,
    pub(crate) http: reqwest::Client,
}

const CACHE_SERVICE: &str = "/twirp/github.actions.results.api.v1.CacheService";

pub(crate) fn router(state: AppState) -> Router {
    let debug = state.config.debug;
    let router = Router::new()
        .route("/", any(|| async { "OK" }))
        .route("/health", any(|| async { "healthy" }))
        .route("/metrics", any(cache::metrics))
        .route(
            &format!("{CACHE_SERVICE}/CreateCacheEntry"),
            post(cache::create_cache_entry),
        )
        .route(
            &format!("{CACHE_SERVICE}/FinalizeCacheEntryUpload"),
            any(cache::finalize_cache_entry_upload),
        )
        .route(
            &format!("{CACHE_SERVICE}/GetCacheEntryDownloadURL"),
            post(cache::get_cache_entry_download_url),
        )
        .route(
            "/devstoreaccount1/upload/{upload_id}",
            put(transfer::upload),
        )
        .route("/upload/{upload_id}", put(transfer::upload))
        .route("/download/{location_id}", any(transfer::download))
        .nest("/management-api", management::router(&state.config))
        .fallback(passthrough::forward)
        .with_state(state);
    if debug {
        router.layer(axum::middleware::from_fn(log_requests))
    } else {
        router
    }
}
