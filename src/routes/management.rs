//! Management API: inspect and delete cache entries and storage locations.
#![expect(
    unused_qualifications,
    reason = "utoipa's path macro qualifies `params(...)` types"
)]

use std::num::NonZeroU32;

use axum::extract::{FromRequestParts, Path, Request, State};
use axum::http::request::Parts;
use axum::http::{HeaderName, StatusCode};
use axum::middleware::Next;
use axum::response::{Html, IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use sea_orm::{
    Condition, EntityTrait as _, PaginatorTrait as _, QueryFilter as _, QuerySelect as _,
};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_qs::DuplicateKeyBehavior;
use tower_http::cors::CorsLayer;
use utoipa::openapi::security::{ApiKey, ApiKeyValue, SecurityScheme};
use utoipa::openapi::{InfoBuilder, SecurityRequirement, ServerBuilder};
use utoipa::{IntoParams, ToSchema};
use utoipa_axum::router::OpenApiRouter;
use utoipa_axum::routes;
use utoipa_scalar::Scalar;

use super::AppState;
use crate::cleanup::Task;
use crate::config::Config;
use crate::db::{CacheEntry, StorageLocation, cache_entries, storage_locations};
use crate::error::Failure;
use crate::storage::{CacheEntryMatch, CacheQuery, LocationDeletion};

const API_KEY_HEADER: HeaderName = HeaderName::from_static("x-api-key");

/// An error in the shape of the original oRPC API: `{ defined, code, status, message }`.
#[derive(Debug, Serialize)]
struct ApiError {
    defined: bool,
    code: &'static str,
    #[serde(serialize_with = "serialize_status")]
    status: StatusCode,
    message: String,
}

#[expect(
    clippy::trivially_copy_pass_by_ref,
    reason = "`serialize_with` passes the field by reference"
)]
fn serialize_status<S: serde::Serializer>(
    status: &StatusCode,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    serializer.serialize_u16(status.as_u16())
}

impl ApiError {
    fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            defined: false,
            code,
            status,
            message: message.into(),
        }
    }

    fn not_found(message: &str) -> Self {
        Self {
            defined: true,
            ..Self::new(StatusCode::NOT_FOUND, "NOT_FOUND", message)
        }
    }

    fn bad_request(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, "BAD_REQUEST", message)
    }
}

impl From<sea_orm::DbErr> for ApiError {
    fn from(error: sea_orm::DbErr) -> Self {
        Failure::from(error).into()
    }
}

impl From<Failure> for ApiError {
    fn from(failure: Failure) -> Self {
        tracing::error!(error = %failure, "management API request failed");
        Self::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "INTERNAL_SERVER_ERROR",
            "Internal server error",
        )
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.status, Json(self)).into_response()
    }
}

/// Query parameters; repeated (`a=1&a=2`) and bracketed (`a[]=1`, `a[0]=1`) keys collect into
/// lists, and a repeated single value is rejected.
struct Query<T>(T);

impl<T: DeserializeOwned + Send, S: Send + Sync> FromRequestParts<S> for Query<T> {
    type Rejection = ApiError;

    fn from_request_parts(
        parts: &mut Parts,
        _state: &S,
    ) -> impl Future<Output = Result<Self, ApiError>> + Send {
        std::future::ready(
            serde_qs::Config::new()
                .duplicate_key_behavior(DuplicateKeyBehavior::Error)
                .deserialize_str(parts.uri.query().unwrap_or_default())
                .map(Self)
                .map_err(|error| {
                    ApiError::bad_request(format!("Input validation failed: {error}"))
                }),
        )
    }
}

/// A filter that may be left out but not set to `null`, which must not widen a deletion.
fn present<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Option<String>, D::Error> {
    String::deserialize(deserializer).map(Some)
}

/// Exact-match filters shared by listing and bulk deletion.
#[derive(Debug, Default, Deserialize, IntoParams, ToSchema)]
#[serde(rename_all = "camelCase")]
#[into_params(parameter_in = Query)]
struct EntryFilter {
    /// Filter by exact cache key
    #[serde(default, deserialize_with = "present")]
    key: Option<String>,
    /// Filter by exact cache version
    #[serde(default, deserialize_with = "present")]
    version: Option<String>,
    /// Filter by exact cache scope
    #[serde(default, deserialize_with = "present")]
    scope: Option<String>,
    /// Filter by exact repository id
    #[param(rename = "repoId")]
    #[schema(rename = "repoId")]
    #[serde(default, deserialize_with = "present")]
    repo_id: Option<String>,
}

impl EntryFilter {
    /// Every given filter must match; an empty filter matches everything.
    fn condition(&self) -> Condition {
        [
            (cache_entries::COLUMN.key, &self.key),
            (cache_entries::COLUMN.version, &self.version),
            (cache_entries::COLUMN.scope, &self.scope),
            (cache_entries::COLUMN.repo_id, &self.repo_id),
        ]
        .into_iter()
        .filter_map(|(column, value)| {
            value
                .as_deref()
                .filter(|value| !value.is_empty())
                .map(|value| (column, value))
        })
        .fold(Condition::all(), |condition, (column, value)| {
            condition.add(column.eq(value))
        })
    }
}

/// Between 1 and 100.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(try_from = "u8")]
struct ItemsPerPage(u8);

impl TryFrom<u8> for ItemsPerPage {
    type Error = &'static str;

    fn try_from(items: u8) -> Result<Self, Self::Error> {
        (1..=100)
            .contains(&items)
            .then_some(Self(items))
            .ok_or("itemsPerPage must be between 1 and 100")
    }
}

impl Default for ItemsPerPage {
    fn default() -> Self {
        Self(20)
    }
}

#[derive(Debug, Deserialize, IntoParams)]
#[serde(rename_all = "camelCase")]
#[into_params(parameter_in = Query)]
struct Pagination {
    /// Number of items per page (1-100, default 20)
    #[param(rename = "itemsPerPage", value_type = Option<u8>, minimum = 1, maximum = 100)]
    #[serde(default)]
    items_per_page: ItemsPerPage,
    /// Page number (default 1)
    #[param(value_type = Option<u32>, minimum = 1)]
    #[serde(default = "first_page")]
    page: NonZeroU32,
}

const fn first_page() -> NonZeroU32 {
    NonZeroU32::MIN
}

#[derive(Debug, Deserialize, IntoParams)]
#[serde(rename_all = "camelCase")]
#[into_params(parameter_in = Query)]
struct MatchQuery {
    /// The primary cache key to match against
    #[param(rename = "primaryKey")]
    primary_key: String,
    /// Optional fallback keys to try if the primary key does not match
    #[param(rename = "restoreKeys")]
    #[serde(default)]
    restore_keys: Vec<String>,
    /// Scopes to search within, checked in order; at least one
    scopes: Vec<String>,
    /// Repository id to match the cache entry against
    #[param(rename = "repoId")]
    repo_id: String,
    /// Cache version identifier
    version: String,
}

#[derive(Debug, Serialize, ToSchema)]
struct CacheEntryPage {
    total: u64,
    items: Vec<CacheEntry>,
}

/// Get cache entry
///
/// Retrieve a single cache entry by its id.
#[utoipa::path(
    get,
    path = "/cache-entries/{id}",
    tag = "Cache Entries",
    responses(
        (status = 200, body = CacheEntry),
        (status = 404, description = "Cache entry not found"),
    ),
)]
async fn get_cache_entry(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<CacheEntry>, ApiError> {
    cache_entries::Entity::find_by_id(id)
        .one(&state.storage.db.pool)
        .await?
        .map(Json)
        .ok_or_else(|| ApiError::not_found("Cache entry not found"))
}

/// Match cache entry
///
/// Find the best matching cache entry using the primary key and optional restore keys across the
/// given scopes. Returns the matched entry along with the match type, or null if no match is
/// found. Basically what the cache server does when deciding which cache entry to restore for a
/// given cache restore request.
#[utoipa::path(
    get,
    path = "/cache-entries/match",
    tag = "Cache Entries",
    params(MatchQuery),
    responses((status = 200, body = Option<CacheEntryMatch>)),
)]
async fn match_cache_entry(
    State(state): State<AppState>,
    Query(query): Query<MatchQuery>,
) -> Result<Json<Option<CacheEntryMatch>>, ApiError> {
    let query = CacheQuery {
        primary_key: query.primary_key,
        restore_keys: query.restore_keys,
        version: query.version,
        scopes: query.scopes,
        repo_id: query.repo_id,
    };
    if query.scopes.is_empty() {
        return Err(ApiError::bad_request(
            "Input validation failed: scopes is required",
        ));
    }
    Ok(Json(state.storage.match_cache_entry(&query).await?))
}

/// List cache entries
///
/// Retrieve a paginated list of cache entries, optionally filtered by key, version, scope and
/// repository.
#[utoipa::path(
    get,
    path = "/cache-entries",
    tag = "Cache Entries",
    params(EntryFilter, Pagination),
    responses((status = 200, body = CacheEntryPage)),
)]
async fn list_cache_entries(
    State(state): State<AppState>,
    Query(filter): Query<EntryFilter>,
    Query(pagination): Query<Pagination>,
) -> Result<Json<CacheEntryPage>, ApiError> {
    let items_per_page = u64::from(pagination.items_per_page.0);
    let page = u64::from(pagination.page.get());
    let db = &state.storage.db.pool;
    let entries = cache_entries::Entity::find().filter(filter.condition());
    let items = entries
        .clone()
        .limit(items_per_page)
        .offset(page.saturating_sub(1).saturating_mul(items_per_page))
        .all(db)
        .await?;
    let total = entries.count(db).await?;
    Ok(Json(CacheEntryPage { total, items }))
}

/// Delete cache entry
///
/// Delete a single cache entry by its id. Triggers cleanup of unreferenced storage locations.
#[utoipa::path(
    delete,
    path = "/cache-entries/{id}",
    tag = "Cache Entries",
    responses((status = 200)),
)]
async fn delete_cache_entry(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<(), ApiError> {
    cache_entries::Entity::delete_by_id(id)
        .exec(&state.storage.db.pool)
        .await?;
    state.cleanup.trigger(Task::StorageLocations);
    Ok(())
}

/// Delete cache entries
///
/// Delete multiple cache entries matching the given filters. Triggers cleanup of unreferenced
/// storage locations.
#[utoipa::path(
    delete,
    path = "/cache-entries",
    tag = "Cache Entries",
    params(EntryFilter),
    request_body(content = EntryFilter, description = "The filters, also accepted as query"),
    responses((status = 200)),
)]
async fn delete_cache_entries(
    State(state): State<AppState>,
    Query(query): Query<EntryFilter>,
    body: axum::body::Bytes,
) -> Result<(), ApiError> {
    // Read whatever the Content-Type.
    let filter = if body.is_empty() {
        query
    } else {
        serde_json::from_slice(&body)
            .map_err(|error| ApiError::bad_request(format!("Input validation failed: {error}")))?
    };
    cache_entries::Entity::delete_many()
        .filter(filter.condition())
        .exec(&state.storage.db.pool)
        .await?;
    state.cleanup.trigger(Task::StorageLocations);
    Ok(())
}

/// Get storage location
///
/// Retrieve a single storage location by its id.
#[utoipa::path(
    get,
    path = "/storage-locations/{id}",
    tag = "Storage Locations",
    responses(
        (status = 200, body = StorageLocation),
        (status = 404, description = "Storage location not found"),
    ),
)]
async fn get_storage_location(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<StorageLocation>, ApiError> {
    storage_locations::Entity::find_by_id(id)
        .one(&state.storage.db.pool)
        .await?
        .map(Json)
        .ok_or_else(|| ApiError::not_found("Storage location not found"))
}

/// Delete storage location
///
/// Delete a storage location by its id. Removes the associated folder from storage, unless a
/// download is reading it.
#[utoipa::path(
    delete,
    path = "/storage-locations/{id}",
    tag = "Storage Locations",
    responses(
        (status = 200),
        (status = 409, description = "Storage location is being downloaded"),
    ),
)]
async fn delete_storage_location(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<(), ApiError> {
    match state.storage.delete_storage_location(&id).await? {
        LocationDeletion::Deleted | LocationDeletion::Missing => Ok(()),
        LocationDeletion::InUse => Err(ApiError {
            defined: true,
            ..ApiError::new(
                StatusCode::CONFLICT,
                "CONFLICT",
                "Storage location is being downloaded",
            )
        }),
    }
}

pub(super) fn router(config: &Config) -> Router<AppState> {
    let Some(api_key) = config.management_api_key.clone() else {
        return Router::new().fallback(|| async {
            crate::http::HttpError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "Management API is disabled",
            )
        });
    };

    let (api, mut openapi) = OpenApiRouter::new()
        .routes(routes!(get_cache_entry, delete_cache_entry))
        .routes(routes!(match_cache_entry))
        .routes(routes!(list_cache_entries, delete_cache_entries))
        .routes(routes!(get_storage_location, delete_storage_location))
        .split_for_parts();
    openapi.info = InfoBuilder::new()
        .title("Cache Server Management API")
        .version("1.0.0")
        .build();
    openapi.servers = Some(vec![
        ServerBuilder::new()
            .url(format!("{}/management-api", config.api_base_url))
            .build(),
    ]);
    openapi
        .components
        .get_or_insert_with(Default::default)
        .add_security_scheme(
            "apiKeyHeader",
            SecurityScheme::ApiKey(ApiKey::Header(ApiKeyValue::new("X-Api-Key"))),
        );
    openapi.security = Some(vec![SecurityRequirement::new(
        "apiKeyHeader",
        Vec::<String>::new(),
    )]);
    let docs = Html(Scalar::new(openapi.clone()).to_html());
    let spec = Json(openapi);

    let authenticated = api.route_layer(axum::middleware::from_fn(
        move |request: Request, next: Next| {
            let authorized = request
                .headers()
                .get(API_KEY_HEADER)
                .is_some_and(|value| value.as_bytes() == api_key.as_bytes());
            async move {
                if authorized {
                    next.run(request).await
                } else {
                    ApiError::new(StatusCode::UNAUTHORIZED, "UNAUTHORIZED", "Unauthorized")
                        .into_response()
                }
            }
        },
    ));
    Router::new()
        .merge(authenticated)
        .route("/_docs", get(move || async move { docs }))
        .route("/_docs/spec.json", get(move || async move { spec }))
        .fallback(|| async { ApiError::new(StatusCode::NOT_FOUND, "NOT_FOUND", "Not found") })
        .layer(CorsLayer::permissive())
}

#[cfg(test)]
mod tests;
