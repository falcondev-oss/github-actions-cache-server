//! Isolated servers, seeded rows and a client speaking the `@actions/cache` protocol.

use std::future::Future;
use std::io;
use std::path::Path;
use std::time::Duration;

use axum::body::Bytes;
use base64::Engine as _;
use futures_util::{StreamExt as _, TryStreamExt as _, stream};
use sea_query::{Expr, JoinType};
use sqlx::Connection as _;
use tempfile::TempDir;
use tokio::net::TcpListener;

use crate::config::Config;
use crate::db::{
    CacheEntries, CacheEntry, Db, StorageLocation, StorageLocations, select_locations,
};
use crate::routes::{AppState, router};
use crate::storage::{Adapter, ByteStream, CacheQuery, EntryIdentity, Storage};

pub(crate) const SCOPE: &str = "refs/heads/main";
pub(crate) const REPO_ID: &str = "123";
pub(crate) const VERSION: &str = "v1";

fn env_or(name: &str, default: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| default.to_owned())
}

fn unique_name() -> String {
    format!("t{}", uuid::Uuid::new_v4().simple())
}

/// Local port of a test service, overridable via `TEST_<SERVICE>_PORT` when the default is taken.
fn port(service: &str, default: &str) -> String {
    env_or(&format!("TEST_{service}_PORT"), default)
}

/// Azurite's well-known development account key.
const AZURITE_KEY: &str =
    "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==";

fn owned(vars: &[(&str, String)]) -> Vec<(String, String)> {
    vars.iter()
        .map(|(key, value)| ((*key).to_owned(), value.clone()))
        .collect()
}

async fn create_database(url: &str, name: &str) {
    sqlx::any::install_default_drivers();
    let mut admin = sqlx::AnyConnection::connect(url).await.unwrap();
    sqlx::query(&format!("create database {name}"))
        .execute(&mut admin)
        .await
        .unwrap();
}

pub(crate) async fn db_vars(dir: &Path) -> Vec<(String, String)> {
    let name = unique_name();
    match env_or("TEST_DB_DRIVER", "sqlite").as_str() {
        "sqlite" => owned(&[
            ("DB_DRIVER", "sqlite".to_owned()),
            (
                "DB_SQLITE_PATH",
                dir.join("db.sqlite").to_string_lossy().into_owned(),
            ),
        ]),
        "postgres" => {
            let server = format!(
                "postgres://postgres:postgres@localhost:{}",
                port("POSTGRES", "5432")
            );
            create_database(&format!("{server}/postgres"), &name).await;
            owned(&[
                ("DB_DRIVER", "postgres".to_owned()),
                ("DB_POSTGRES_URL", format!("{server}/{name}")),
            ])
        }
        "mysql" => {
            let mysql_port = port("MYSQL", "3306");
            let server = format!("mysql://root:root@127.0.0.1:{mysql_port}");
            create_database(&server, &name).await;
            owned(&[
                ("DB_DRIVER", "mysql".to_owned()),
                ("DB_MYSQL_DATABASE", name),
                ("DB_MYSQL_HOST", "127.0.0.1".to_owned()),
                ("DB_MYSQL_PORT", mysql_port),
                ("DB_MYSQL_USER", "root".to_owned()),
                ("DB_MYSQL_PASSWORD", "root".to_owned()),
            ])
        }
        other => panic!("unknown TEST_DB_DRIVER {other}"),
    }
}

fn storage_vars(dir: &Path) -> Vec<(String, String)> {
    match storage_driver().as_str() {
        "filesystem" => owned(&[
            ("STORAGE_DRIVER", "filesystem".to_owned()),
            (
                "STORAGE_FILESYSTEM_PATH",
                dir.join("storage").to_string_lossy().into_owned(),
            ),
        ]),
        "s3" => owned(&[
            ("STORAGE_DRIVER", "s3".to_owned()),
            ("STORAGE_S3_BUCKET", "test".to_owned()),
            ("AWS_REGION", "us-east-1".to_owned()),
            (
                "AWS_ENDPOINT_URL",
                format!("http://localhost:{}", port("S3", "9000")),
            ),
            ("AWS_ACCESS_KEY_ID", "rustfsadmin".to_owned()),
            ("AWS_SECRET_ACCESS_KEY", "rustfsadmin".to_owned()),
        ]),
        "gcs" => {
            let endpoint = format!("http://localhost:{}", port("GCS", "4443"));
            let key = dir.join("gcs.json");
            let credentials = serde_json::json!({
                "private_key": "",
                "private_key_id": "",
                "client_email": "",
                "gcs_base_url": endpoint,
                "disable_oauth": true,
            });
            std::fs::write(&key, credentials.to_string()).unwrap();
            owned(&[
                ("STORAGE_DRIVER", "gcs".to_owned()),
                ("STORAGE_GCS_BUCKET", "test".to_owned()),
                ("STORAGE_GCS_ENDPOINT", endpoint),
                (
                    "STORAGE_GCS_SERVICE_ACCOUNT_KEY",
                    key.to_string_lossy().into_owned(),
                ),
            ])
        }
        "azblob" => owned(&[
            ("STORAGE_DRIVER", "azblob".to_owned()),
            ("STORAGE_AZBLOB_CONTAINER", "test".to_owned()),
            (
                "STORAGE_AZBLOB_CONNECTION_STRING",
                format!(
                    "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;\
                     AccountKey={AZURITE_KEY};BlobEndpoint=http://localhost:{}/devstoreaccount1;",
                    port("AZBLOB", "10000"),
                ),
            ),
        ]),
        other => panic!("unknown TEST_STORAGE_DRIVER {other}"),
    }
}

pub(crate) fn storage_driver() -> String {
    env_or("TEST_STORAGE_DRIVER", "filesystem")
}

/// A server with its own database and storage, listening on a random local port.
pub(crate) struct TestServer {
    pub(crate) url: String,
    pub(crate) state: AppState,
    vars: Vec<(String, String)>,
    prefix: String,
    _dir: TempDir,
}

impl TestServer {
    pub(crate) async fn start() -> Self {
        Self::with(&[]).await
    }

    pub(crate) async fn with(overrides: &[(&str, &str)]) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let mut vars = db_vars(dir.path()).await;
        vars.extend(storage_vars(dir.path()));
        for (key, value) in [
            ("API_BASE_URL", url.as_str()),
            ("SKIP_TOKEN_VALIDATION", "true"),
            ("CACHE_FILESYSTEM_MAX_USAGE_PERCENT", "100"),
        ]
        .iter()
        .chain(overrides)
        {
            vars.push(((*key).to_owned(), (*value).to_owned()));
        }
        let prefix = format!("{}/gh-actions-cache", uuid::Uuid::new_v4());
        let config = Config::from_vars(vars.clone()).unwrap();
        let adapter = Adapter::isolated(&config.storage, &prefix).await.unwrap();
        let state = crate::build_state(config, adapter).await.unwrap();
        let app = router(state.clone());
        drop(tokio::spawn(
            async move { axum::serve(listener, app).await },
        ));
        Self {
            url,
            state,
            vars,
            prefix,
            _dir: dir,
        }
    }

    pub(crate) fn storage(&self) -> &Storage {
        &self.state.storage
    }

    pub(crate) fn db(&self) -> &Db {
        &self.state.storage.db
    }

    pub(crate) fn adapter(&self) -> &Adapter {
        &self.state.storage.adapter
    }

    /// Another `Storage` over the same database and data, with different settings.
    pub(crate) async fn storage_with(&self, overrides: &[(&str, &str)]) -> Storage {
        let vars = self.vars.iter().cloned().chain(
            overrides
                .iter()
                .map(|&(key, value)| (key.to_owned(), value.to_owned())),
        );
        let config = Config::from_vars(vars).unwrap();
        let adapter = Adapter::isolated(&config.storage, &self.prefix)
            .await
            .unwrap();
        Storage::new(self.db().clone(), adapter, std::sync::Arc::new(config))
            .await
            .unwrap()
    }

    pub(crate) fn client(&self) -> CacheClient {
        CacheClient::new(&self.url, &[(SCOPE, 3)])
    }
}

pub(crate) fn byte_stream(data: impl Into<Bytes>) -> ByteStream {
    stream::once(std::future::ready(Ok(data.into()))).boxed()
}

pub(crate) async fn read_all(stream: ByteStream) -> io::Result<Vec<u8>> {
    stream.map_ok(|chunk| chunk.to_vec()).try_concat().await
}

pub(crate) async fn put(adapter: &Adapter, name: &str, data: &'static [u8]) {
    adapter
        .upload_stream(name, byte_stream(data))
        .await
        .unwrap();
}

/// Polls `check` until it holds, for asynchronous effects such as lease release on drop.
pub(crate) async fn eventually<F: Future<Output = bool>>(mut check: impl FnMut() -> F) {
    for _ in 0..100 {
        if check().await {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("condition not met within 5s");
}

/// A location whose data is one Part.
pub(crate) fn unmerged_location(folder_name: &str) -> StorageLocation {
    StorageLocation {
        id: uuid::Uuid::new_v4().to_string(),
        folder_name: folder_name.to_owned(),
        part_count: 1,
        merge_started_at: None,
        merged_at: None,
        parts_deleted_at: None,
        last_downloaded_at: None,
        size_bytes: None,
    }
}

/// A location whose data is its merged object; its Parts are gone.
pub(crate) fn merged_location(folder_name: &str) -> StorageLocation {
    let now = Some(crate::db::now_ms());
    StorageLocation {
        part_count: 0,
        merge_started_at: now,
        merged_at: now,
        parts_deleted_at: now,
        ..unmerged_location(folder_name)
    }
}

pub(crate) fn entry(key: &str, location_id: &str, updated_at: i64) -> CacheEntry {
    CacheEntry {
        id: uuid::Uuid::new_v4().to_string(),
        key: key.to_owned(),
        version: VERSION.to_owned(),
        scope: SCOPE.to_owned(),
        repo_id: REPO_ID.to_owned(),
        updated_at,
        location_id: location_id.to_owned(),
    }
}

pub(crate) async fn insert_location(db: &Db, location: &StorageLocation) {
    crate::db::insert_location(db, &db.pool, location)
        .await
        .unwrap();
}

pub(crate) async fn insert_entry(db: &Db, entry: &CacheEntry) {
    crate::db::insert_entry(db, &db.pool, entry).await.unwrap();
}

pub(crate) async fn find_location(db: &Db, id: &str) -> Option<StorageLocation> {
    db.optional(
        &db.pool,
        select_locations().and_where(Expr::col(StorageLocations::Id).eq(id)),
    )
    .await
    .unwrap()
}

/// A lookup for `keys`, primary key first, in the default scope.
pub(crate) fn query(keys: &[&str]) -> CacheQuery {
    CacheQuery {
        primary_key: keys[0].to_owned(),
        restore_keys: keys[1..].iter().map(|&key| key.to_owned()).collect(),
        version: VERSION.to_owned(),
        scopes: vec![SCOPE.to_owned()],
        repo_id: REPO_ID.to_owned(),
    }
}

pub(crate) fn identity(key: &str) -> EntryIdentity {
    EntryIdentity {
        key: key.to_owned(),
        version: VERSION.to_owned(),
        scope: SCOPE.to_owned(),
        repo_id: REPO_ID.to_owned(),
    }
}

/// Saves `parts` as one upload through the storage API and returns its storage location.
pub(crate) async fn save_parts(storage: &Storage, key: &str, parts: &[Vec<u8>]) -> StorageLocation {
    let crate::storage::CreatedUpload::Created { id } =
        storage.create_upload(&identity(key)).await.unwrap()
    else {
        panic!("upload for {key} already exists");
    };
    for (index, part) in parts.iter().enumerate() {
        let index = u32::try_from(index).unwrap();
        storage
            .upload_part(id, index, byte_stream(part.clone()))
            .await
            .unwrap();
    }
    storage
        .complete_upload(&identity(key))
        .await
        .unwrap()
        .unwrap();
    let db = &storage.db;
    let row: Option<StorageLocation> = db
        .optional(
            &db.pool,
            select_locations()
                .join(
                    JoinType::InnerJoin,
                    CacheEntries::Table,
                    Expr::col((CacheEntries::Table, CacheEntries::LocationId))
                        .equals((StorageLocations::Table, StorageLocations::Id)),
                )
                .and_where(Expr::col((CacheEntries::Table, CacheEntries::Key)).eq(key)),
        )
        .await
        .unwrap();
    row.unwrap()
}

/// Speaks the Twirp JSON + Azure block protocol the way `@actions/cache` does.
pub(crate) struct CacheClient {
    http: reqwest::Client,
    base: String,
    token: String,
}

const SERVICE: &str = "twirp/github.actions.results.api.v1.CacheService";

impl CacheClient {
    pub(crate) fn new(base: &str, scopes: &[(&str, i64)]) -> Self {
        let scopes: Vec<_> = scopes
            .iter()
            .map(|(scope, permission)| {
                serde_json::json!({ "Scope": scope, "Permission": permission })
            })
            .collect();
        let claims = serde_json::json!({
            "ac": serde_json::to_string(&scopes).unwrap(),
            "repository_id": REPO_ID,
        });
        let token = jsonwebtoken::encode(
            &jsonwebtoken::Header::default(),
            &claims,
            &jsonwebtoken::EncodingKey::from_secret(b"mock-secret-key"),
        )
        .unwrap();
        Self {
            http: reqwest::Client::new(),
            base: base.to_owned(),
            token,
        }
    }

    pub(crate) async fn twirp(&self, method: &str, body: &serde_json::Value) -> reqwest::Response {
        self.http
            .post(format!("{}/{SERVICE}/{method}", self.base))
            .bearer_auth(&self.token)
            .json(body)
            .send()
            .await
            .unwrap()
    }

    pub(crate) async fn twirp_protobuf(&self, method: &str, body: Vec<u8>) -> reqwest::Response {
        self.http
            .post(format!("{}/{SERVICE}/{method}", self.base))
            .bearer_auth(&self.token)
            .header("content-type", "application/protobuf")
            .body(body)
            .send()
            .await
            .unwrap()
    }

    /// Uploads `data` in `chunk`-sized blocks to a signed upload URL.
    pub(crate) async fn upload_blocks(&self, url: &str, data: &[u8], chunk: usize) {
        let block_prefix = uuid::Uuid::new_v4();
        for (index, block) in data.chunks(chunk).enumerate() {
            let block_id = base64::engine::general_purpose::STANDARD
                .encode(format!("{block_prefix}{index:012}"));
            let response = self
                .http
                .put(url)
                .query(&[("comp", "block"), ("blockid", block_id.as_str())])
                .body(block.to_vec())
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), 201, "block {index} is accepted");
        }
        let response = self
            .http
            .put(url)
            .query(&[("comp", "blocklist")])
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 201, "block list is accepted");
        assert!(
            response.headers().contains_key("x-ms-request-id"),
            "request id is set"
        );
    }

    pub(crate) async fn save(&self, key: &str, data: &[u8], chunk: usize) {
        let created = self
            .twirp(
                "CreateCacheEntry",
                &serde_json::json!({ "key": key, "version": VERSION }),
            )
            .await;
        assert_eq!(created.status(), 200, "cache entry is reserved");
        let created: serde_json::Value = created.json().await.unwrap();
        self.upload_blocks(created["signed_upload_url"].as_str().unwrap(), data, chunk)
            .await;
        let finalized = self
            .twirp(
                "FinalizeCacheEntryUpload",
                &serde_json::json!({
                    "key": key,
                    "version": VERSION,
                    "size_bytes": data.len().to_string(),
                }),
            )
            .await;
        assert_eq!(finalized.status(), 200, "upload is finalized");
    }

    /// The matched key and downloaded bytes, or `None` on a cache miss.
    pub(crate) async fn restore(
        &self,
        key: &str,
        restore_keys: &[&str],
    ) -> Option<(String, Vec<u8>)> {
        let response = self
            .twirp(
                "GetCacheEntryDownloadURL",
                &serde_json::json!({
                    "key": key,
                    "restore_keys": restore_keys,
                    "version": VERSION,
                }),
            )
            .await;
        assert_eq!(response.status(), 200, "lookup succeeds");
        let body: serde_json::Value = response.json().await.unwrap();
        if body["ok"] != serde_json::json!(true) {
            return None;
        }
        let download = self
            .http
            .get(body["signed_download_url"].as_str().unwrap())
            .send()
            .await
            .unwrap();
        assert_eq!(download.status(), 200, "download succeeds");
        let bytes = download.bytes().await.unwrap().to_vec();
        Some((body["matched_key"].as_str().unwrap().to_owned(), bytes))
    }
}
