//! Management API: inspect and delete cache entries and storage locations.
#![expect(
    unused_qualifications,
    reason = "utoipa's path macro qualifies `params(...)` types"
)]

use std::collections::HashMap;
use std::str::FromStr;

use axum::extract::{Path, RawQuery, Request, State};
use axum::http::{HeaderName, StatusCode};
use axum::middleware::Next;
use axum::response::{Html, IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use sea_query::{Alias, Asterisk, Cond, Expr, Query};
use serde::{Deserialize, Serialize};
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
use crate::db::{
    CacheEntries, CacheEntry, StorageLocation, StorageLocations, TotalRow, select_entries,
    select_locations,
};
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

/// Query parameters; repeated (`a=1&a=2`) and bracketed (`a[]=1`, `a[0]=1`) keys collect.
struct Params(HashMap<String, Vec<String>>);

impl Params {
    fn parse(raw: Option<&str>) -> Self {
        let mut params: HashMap<String, Vec<String>> = HashMap::new();
        for (key, value) in url::form_urlencoded::parse(raw.unwrap_or_default().as_bytes()) {
            let key = match key.split_once('[') {
                Some((name, rest)) if rest.ends_with(']') => name.to_owned(),
                Some(_) | None => key.into_owned(),
            };
            params.entry(key).or_default().push(value.into_owned());
        }
        Self(params)
    }

    fn list(&self, key: &str) -> Vec<String> {
        self.0.get(key).cloned().unwrap_or_default()
    }

    fn optional(&self, key: &str) -> Result<Option<String>, ApiError> {
        match self.0.get(key).map(Vec::as_slice) {
            None | Some([]) => Ok(None),
            Some([value]) => Ok(Some(value.clone())),
            Some(_) => Err(ApiError::bad_request(format!(
                "Input validation failed: {key} must be a single value"
            ))),
        }
    }

    fn required(&self, key: &str) -> Result<String, ApiError> {
        self.optional(key)?.ok_or_else(|| {
            ApiError::bad_request(format!("Input validation failed: {key} is required"))
        })
    }

    fn integer<T: FromStr + PartialOrd>(
        &self,
        key: &str,
        default: T,
        range: std::ops::RangeInclusive<T>,
    ) -> Result<T, ApiError> {
        let invalid = || {
            ApiError::bad_request(format!(
                "Input validation failed: {key} must be an integer in range"
            ))
        };
        self.optional(key)?.map_or(Ok(default), |value| {
            value
                .parse()
                .ok()
                .filter(|parsed| range.contains(parsed))
                .ok_or_else(invalid)
        })
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
    fn parse(params: &Params) -> Result<Self, ApiError> {
        Ok(Self {
            key: params.optional("key")?,
            version: params.optional("version")?,
            scope: params.optional("scope")?,
            repo_id: params.optional("repoId")?,
        })
    }

    /// Every given filter must match; an empty filter matches everything.
    fn condition(&self) -> Cond {
        [
            (CacheEntries::Key, &self.key),
            (CacheEntries::Version, &self.version),
            (CacheEntries::Scope, &self.scope),
            (CacheEntries::RepoId, &self.repo_id),
        ]
        .into_iter()
        .filter_map(|(column, value)| {
            value
                .as_deref()
                .filter(|value| !value.is_empty())
                .map(|value| (column, value))
        })
        .fold(Cond::all(), |condition, (column, value)| {
            condition.add(Expr::col(column).eq(value))
        })
    }
}

#[derive(Debug, IntoParams)]
#[into_params(parameter_in = Query)]
#[expect(
    dead_code,
    reason = "documents the query string, which is parsed by `Params`"
)]
struct Pagination {
    /// Number of items per page (1-100, default 20)
    #[param(rename = "itemsPerPage")]
    items_per_page: Option<u32>,
    /// Page number (default 1)
    page: Option<u32>,
}

#[derive(Debug, IntoParams)]
#[into_params(parameter_in = Query)]
#[expect(
    dead_code,
    reason = "documents the query string, which is parsed by `Params`"
)]
struct MatchQuery {
    /// The primary cache key to match against
    #[param(rename = "primaryKey")]
    primary_key: String,
    /// Optional fallback keys to try if the primary key does not match
    #[param(rename = "restoreKeys")]
    restore_keys: Option<Vec<String>>,
    /// Scopes to search within, checked in order
    scopes: Vec<String>,
    /// Repository id to match the cache entry against
    #[param(rename = "repoId")]
    repo_id: String,
    /// Cache version identifier
    version: String,
}

#[derive(Debug, Serialize, ToSchema)]
struct CacheEntryPage {
    total: i64,
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
    let db = &state.storage.db;
    let entry: Option<CacheEntry> = db
        .optional(
            &db.pool,
            select_entries().and_where(Expr::col(CacheEntries::Id).eq(id)),
        )
        .await?;
    entry
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
    RawQuery(raw): RawQuery,
) -> Result<Json<Option<CacheEntryMatch>>, ApiError> {
    let params = Params::parse(raw.as_deref());
    let query = CacheQuery {
        primary_key: params.required("primaryKey")?,
        restore_keys: params.list("restoreKeys"),
        version: params.required("version")?,
        scopes: params.list("scopes"),
        repo_id: params.required("repoId")?,
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
    RawQuery(raw): RawQuery,
) -> Result<Json<CacheEntryPage>, ApiError> {
    let params = Params::parse(raw.as_deref());
    let filter = EntryFilter::parse(&params)?;
    let items_per_page: u64 = params.integer("itemsPerPage", 20, 1..=100)?;
    let page: u64 = params.integer("page", 1, 1..=u64::from(u32::MAX))?;
    let db = &state.storage.db;
    let items: Vec<CacheEntry> = db
        .all(
            &db.pool,
            select_entries()
                .cond_where(filter.condition())
                .limit(items_per_page)
                .offset(page.saturating_sub(1).saturating_mul(items_per_page)),
        )
        .await?;
    let total: TotalRow = db
        .one(
            &db.pool,
            Query::select()
                .expr_as(Expr::col(Asterisk).count(), Alias::new("total"))
                .from(CacheEntries::Table)
                .cond_where(filter.condition()),
        )
        .await?;
    Ok(Json(CacheEntryPage {
        total: total.total,
        items,
    }))
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
    let db = &state.storage.db;
    db.execute(
        &db.pool,
        Query::delete()
            .from_table(CacheEntries::Table)
            .and_where(Expr::col(CacheEntries::Id).eq(id)),
    )
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
    RawQuery(raw): RawQuery,
    body: Option<Json<EntryFilter>>,
) -> Result<(), ApiError> {
    let filter = match body {
        Some(Json(filter)) => filter,
        None => EntryFilter::parse(&Params::parse(raw.as_deref()))?,
    };
    let db = &state.storage.db;
    db.execute(
        &db.pool,
        Query::delete()
            .from_table(CacheEntries::Table)
            .cond_where(filter.condition()),
    )
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
    let db = &state.storage.db;
    let location: Option<StorageLocation> = db
        .optional(
            &db.pool,
            select_locations().and_where(Expr::col(StorageLocations::Id).eq(id)),
        )
        .await?;
    location
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
mod tests {
    use super::*;

    #[test]
    fn collects_repeated_and_bracketed_params() {
        let params = Params::parse(Some(
            "scopes=a&scopes=b&restoreKeys[]=x&restoreKeys[1]=y&key=k",
        ));
        assert_eq!(params.list("scopes"), ["a", "b"], "repeated");
        assert_eq!(params.list("restoreKeys"), ["x", "y"], "bracketed");
        assert_eq!(params.required("key").unwrap(), "k", "single");
        assert!(
            params.optional("scopes").is_err(),
            "a list is not a single value"
        );
    }
}
