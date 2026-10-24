//! Storage on S3, Google Cloud Storage or Azure Blob Storage via `object_store`.

use std::collections::HashMap;
use std::io;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use axum::http::Method;
use axum::http::header::CONTENT_LENGTH;
use futures_util::{StreamExt as _, TryStreamExt as _};
use object_store::aws::{AmazonS3, AmazonS3Builder};
use object_store::azure::{AzureConfigKey, MicrosoftAzure, MicrosoftAzureBuilder};
use object_store::buffered::BufWriter;
use object_store::gcp::{GoogleCloudStorage, GoogleCloudStorageBuilder};
use object_store::path::Path;
use object_store::signer::Signer;
use object_store::{ClientOptions, GetOptions, GetRange, ObjectStore, ObjectStoreExt as _};
use tokio::io::AsyncWriteExt as _;

use super::adapter::{
    ByteStream, DownloadStream, Extent, RangeRequest, ReadError, StorageDeletion, StorageFolder,
    StorageObject, UploadKind, clamp_range,
};
use crate::config::{AzBlobAuth, StorageConfig};
use crate::error::{Failure, Result};

/// Every object lives below this prefix, shared with the original implementation.
const KEY_PREFIX: &str = "gh-actions-cache";
/// Matches S3's minimum multipart part size, so larger uploads stream in 5 MiB parts.
const UPLOAD_PART_BYTES: usize = 5 * 1024 * 1024;
/// Multipart parts a Merge uploads at once.
const MERGE_UPLOAD_CONCURRENCY: usize = 4;
const READ_TIMEOUT: Duration = Duration::from_secs(30);
/// How long an object seen to exist is trusted without asking storage again.
const KNOWN_OBJECT_LIFETIME: Duration = Duration::from_mins(1);
/// Bounds the memory of remembered objects.
const MAX_KNOWN_OBJECTS: usize = 100_000;
/// The largest single PUT S3 accepts; larger objects go up in parts.
const MAX_SINGLE_PUT_BYTES: u64 = 5 * 1024 * 1024 * 1024;
/// Lifetime of a presigned URL a Part is streamed to; covers a slow client.
const PRESIGNED_UPLOAD_LIFETIME: Duration = Duration::from_hours(1);

#[derive(Debug)]
pub(crate) struct ObjectAdapter {
    store: Arc<dyn ObjectStore>,
    signer: Arc<dyn Signer>,
    prefix: Path,
    /// Streams Parts of a known length to presigned URLs.
    http: reqwest::Client,
    /// Headers a presigned single-request upload needs on this backend.
    put_headers: &'static [(&'static str, &'static str)],
    /// Objects recently seen to exist, so lookups skip a request each. Objects never change, and
    /// deletions through this adapter evict them; the lifetime bounds deletions made elsewhere.
    known: Mutex<HashMap<Path, Instant>>,
}

fn client_options(read_timeout: Duration) -> ClientOptions {
    let options = ClientOptions::new().with_timeout_disabled();
    if read_timeout.is_zero() {
        options.with_read_timeout_disabled()
    } else {
        options.with_read_timeout(read_timeout)
    }
}

/// The client for presigned uploads, with the store's read timeout.
fn presigned_client(read_timeout: Duration) -> reqwest::Result<reqwest::Client> {
    let builder = reqwest::Client::builder();
    if read_timeout.is_zero() {
        builder.build()
    } else {
        builder.read_timeout(read_timeout).build()
    }
}

/// Configures `builder` from a connection string. `allow_http` lives in the client options, so they
/// must already be set: replacing them afterwards would turn plain-HTTP endpoints back off.
fn azure_from_connection_string(
    builder: MicrosoftAzureBuilder,
    connection_string: &str,
) -> Result<MicrosoftAzureBuilder> {
    let pairs: HashMap<&str, &str> = connection_string
        .split(';')
        .filter_map(|pair| pair.split_once('='))
        .map(|(key, value)| (key.trim(), value.trim()))
        .collect();
    if pairs.get("UseDevelopmentStorage") == Some(&"true") {
        return Ok(builder.with_use_emulator(true));
    }
    let account = pairs
        .get("AccountName")
        .ok_or_else(|| Failure::msg("Azure connection string has no AccountName"))?;
    let endpoint = pairs.get("BlobEndpoint").map_or_else(
        || {
            let protocol = pairs.get("DefaultEndpointsProtocol").unwrap_or(&"https");
            let suffix = pairs.get("EndpointSuffix").unwrap_or(&"core.windows.net");
            format!("{protocol}://{account}.blob.{suffix}")
        },
        |endpoint| (*endpoint).to_owned(),
    );
    let mut builder = builder
        .with_account(*account)
        .with_allow_http(endpoint.starts_with("http://"))
        .with_endpoint(endpoint);
    if let Some(key) = pairs.get("AccountKey") {
        builder = builder.with_access_key(*key);
    }
    if let Some(sas) = pairs.get("SharedAccessSignature") {
        builder = builder.with_config(AzureConfigKey::SasKey, *sas);
    }
    Ok(builder)
}

const fn not_found(error: &object_store::Error) -> bool {
    matches!(error, object_store::Error::NotFound { .. })
}

impl ObjectAdapter {
    pub(crate) async fn from_config(config: &StorageConfig) -> Result<Self> {
        Self::with_prefix(config, Path::from(KEY_PREFIX)).await
    }

    /// Builds the adapter below a custom prefix, which isolates tests sharing a bucket.
    pub(crate) async fn with_prefix(config: &StorageConfig, prefix: Path) -> Result<Self> {
        let mut put_headers: &'static [(&'static str, &'static str)] = &[];
        let mut read_timeout = READ_TIMEOUT;
        let (store, signer): (Arc<dyn ObjectStore>, Arc<dyn Signer>) = match config {
            StorageConfig::S3 {
                bucket,
                socket_timeout,
                region,
                endpoint_url,
                access_key_id,
                secret_access_key,
            } => {
                read_timeout = *socket_timeout;
                let mut builder = AmazonS3Builder::from_env()
                    .with_bucket_name(bucket)
                    .with_region(region)
                    .with_virtual_hosted_style_request(false)
                    .with_client_options(client_options(*socket_timeout));
                if let Some(endpoint) = endpoint_url {
                    builder = builder
                        .with_allow_http(endpoint.scheme() == "http")
                        .with_endpoint(endpoint.as_str().trim_end_matches('/'));
                }
                if let Some(key) = access_key_id {
                    builder = builder.with_access_key_id(key);
                }
                if let Some(secret) = secret_access_key {
                    builder = builder.with_secret_access_key(secret);
                }
                let store = Arc::new(builder.build()?);
                (Arc::<AmazonS3>::clone(&store), store)
            }
            StorageConfig::Gcs {
                bucket,
                service_account_key,
                endpoint,
            } => {
                let mut builder = GoogleCloudStorageBuilder::from_env()
                    .with_bucket_name(bucket)
                    .with_client_options(client_options(READ_TIMEOUT));
                if let Some(key) = service_account_key {
                    builder = builder.with_service_account_path(key.to_string_lossy());
                }
                if let Some(endpoint) = endpoint {
                    builder = builder
                        .with_base_url(endpoint.as_str().trim_end_matches('/'))
                        .with_client_options(
                            client_options(READ_TIMEOUT)
                                .with_allow_http(endpoint.scheme() == "http"),
                        );
                }
                let store = Arc::new(builder.build()?);
                (Arc::<GoogleCloudStorage>::clone(&store), store)
            }
            StorageConfig::AzBlob { container, auth } => {
                let options = client_options(READ_TIMEOUT);
                let builder = match auth {
                    AzBlobAuth::ConnectionString(connection_string) => {
                        azure_from_connection_string(
                            MicrosoftAzureBuilder::new().with_client_options(options),
                            connection_string,
                        )?
                    }
                    AzBlobAuth::Account { account, endpoint } => {
                        let builder = MicrosoftAzureBuilder::from_env()
                            .with_client_options(options)
                            .with_account(account);
                        match endpoint {
                            Some(endpoint) => builder
                                .with_allow_http(endpoint.scheme() == "http")
                                .with_endpoint(endpoint.as_str().trim_end_matches('/').to_owned()),
                            None => builder,
                        }
                    }
                };
                let store = Arc::new(builder.with_container_name(container).build()?);
                put_headers = &[("x-ms-blob-type", "BlockBlob")];
                (Arc::<MicrosoftAzure>::clone(&store), store)
            }
            StorageConfig::Filesystem { .. } => {
                return Err(Failure::msg("filesystem storage is not an object store"));
            }
        };

        // Fail fast on a missing bucket or bad credentials instead of on the first upload.
        store
            .list_with_delimiter(Some(&prefix))
            .await
            .map_err(|error| Failure::msg(format!("storage {store} is not accessible: {error}")))?;

        Ok(Self {
            store,
            signer,
            prefix,
            http: presigned_client(read_timeout)?,
            put_headers,
            known: Mutex::default(),
        })
    }

    fn path(&self, name: &str) -> Path {
        Path::from(format!("{}/{name}", self.prefix))
    }

    pub(crate) async fn download_stream(
        &self,
        name: &str,
        range: Option<RangeRequest>,
    ) -> Result<DownloadStream, ReadError> {
        let path = self.path(name);
        let read_error = |error: object_store::Error| {
            if not_found(&error) {
                ReadError::NotFound(name.to_owned())
            } else {
                ReadError::Failed(error.into())
            }
        };
        let Some(range) = range else {
            let result = self.store.get(&path).await.map_err(read_error)?;
            let size = result.meta.size;
            return Ok(DownloadStream {
                stream: result.into_stream().map_err(io::Error::other).boxed(),
                extent: Extent::Whole { size },
            });
        };
        // Resolving the range against the object length first keeps "past the end" a 416 on
        // every backend, whose own answers to it differ.
        let size = self.store.head(&path).await.map_err(read_error)?.size;
        // An empty object has no satisfiable range; serve it whole, like the filesystem does.
        if size == 0 {
            return Ok(DownloadStream {
                stream: futures_util::stream::empty().boxed(),
                extent: Extent::Whole { size: 0 },
            });
        }
        let served = clamp_range(range, size)
            .ok_or_else(|| ReadError::RangeNotSatisfiable(name.to_owned()))?;
        let options = GetOptions {
            range: Some(GetRange::Bounded(
                served.start..served.end.saturating_add(1),
            )),
            ..GetOptions::default()
        };
        let result = self
            .store
            .get_opts(&path, options)
            .await
            .map_err(read_error)?;
        Ok(DownloadStream {
            stream: result.into_stream().map_err(io::Error::other).boxed(),
            extent: Extent::Partial {
                range: served,
                size,
            },
        })
    }

    pub(crate) async fn upload_stream(
        &self,
        name: &str,
        mut stream: ByteStream,
        kind: UploadKind,
    ) -> Result<()> {
        // An object of known length streams through in one request, unbuffered; a single PUT
        // is atomic like a multipart upload.
        if let Some(length) = kind
            .length()
            .filter(|&length| length <= MAX_SINGLE_PUT_BYTES)
        {
            match self
                .signer
                .signed_url(Method::PUT, &self.path(name), PRESIGNED_UPLOAD_LIFETIME)
                .await
            {
                Ok(url) => return self.put_presigned(url, stream, length).await,
                Err(error) => tracing::debug!(%error, "can't presign an upload; buffering it"),
            }
        }
        // Every in-flight multipart part is buffered, so only a Merge, the one stream per entry,
        // uploads several at once; Parts arrive in parallel already.
        let concurrency = match kind {
            UploadKind::Part { .. } => 1,
            UploadKind::Merged { .. } => MERGE_UPLOAD_CONCURRENCY,
        };
        let mut writer =
            BufWriter::with_capacity(Arc::clone(&self.store), self.path(name), UPLOAD_PART_BYTES)
                .with_max_concurrency(concurrency);
        let streamed: Result<()> = async {
            while let Some(chunk) = stream.try_next().await? {
                writer.put(chunk).await?;
            }
            Ok(())
        }
        .await;
        // `abort` panics once `shutdown` has started, so only a failure while streaming aborts;
        // a failed completion leaves nothing visible either way.
        if let Err(failure) = streamed {
            if let Err(error) = writer.abort().await {
                tracing::warn!(%error, object = name, "failed to abort upload");
            }
            return Err(failure);
        }
        writer.shutdown().await?;
        Ok(())
    }

    async fn put_presigned(&self, url: url::Url, stream: ByteStream, length: u64) -> Result<()> {
        let mut request = self
            .http
            .put(url)
            .header(CONTENT_LENGTH, length)
            .body(reqwest::Body::wrap_stream(stream));
        for (name, value) in self.put_headers {
            request = request.header(*name, *value);
        }
        let response = request.send().await?;
        let status = response.status();
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            return Err(Failure::msg(format!(
                "storage rejected an upload: {status} {body}"
            )));
        }
        Ok(())
    }

    pub(crate) async fn object_exists(&self, name: &str) -> Result<bool> {
        let path = self.path(name);
        if self
            .known()
            .get(&path)
            .is_some_and(|seen| seen.elapsed() < KNOWN_OBJECT_LIFETIME)
        {
            return Ok(true);
        }
        match self.store.head(&path).await {
            Ok(_) => {
                self.remember(path);
                Ok(true)
            }
            Err(error) if not_found(&error) => Ok(false),
            Err(error) => Err(error.into()),
        }
    }

    fn known(&self) -> MutexGuard<'_, HashMap<Path, Instant>> {
        // The map holds no invariant a panicking holder could break.
        self.known.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn remember(&self, path: Path) {
        let mut known = self.known();
        if known.len() >= MAX_KNOWN_OBJECTS {
            known.retain(|_, seen| seen.elapsed() < KNOWN_OBJECT_LIFETIME);
            if known.len() >= MAX_KNOWN_OBJECTS {
                known.clear();
            }
        }
        known.insert(path, Instant::now());
    }

    fn forget(&self, prefix: &Path) {
        self.known()
            .retain(|path, _| path.prefix_match(prefix).is_none());
    }

    async fn delete_prefix(&self, prefix: &Path) -> Result<StorageDeletion> {
        // Forgotten before and after, so a lookup racing the deletion can't keep it known.
        self.forget(prefix);
        let deleted = self.delete_listed(prefix).await;
        self.forget(prefix);
        deleted
    }

    async fn delete_listed(&self, prefix: &Path) -> Result<StorageDeletion> {
        let objects: Vec<_> = self.store.list(Some(prefix)).try_collect().await?;
        let deletion = StorageDeletion {
            objects: u64::try_from(objects.len()).unwrap_or(u64::MAX),
            bytes: objects
                .iter()
                .fold(0_u64, |total, object| total.saturating_add(object.size)),
        };
        let locations =
            futures_util::stream::iter(objects.into_iter().map(|object| Ok(object.location)));
        let failures: Vec<_> = self
            .store
            .delete_stream(locations.boxed())
            .filter_map(|result| async move { result.err().filter(|error| !not_found(error)) })
            .collect()
            .await;
        if let Some(first) = failures.first() {
            return Err(Failure::msg(format!(
                "failed to delete {} object(s) from {}: {first}",
                failures.len(),
                self.store
            )));
        }
        Ok(deletion)
    }

    pub(crate) async fn delete_folder(&self, folder: &str) -> Result<StorageDeletion> {
        self.delete_prefix(&self.path(folder)).await
    }

    pub(crate) async fn list_folder(&self, folder: &str) -> Result<Vec<StorageObject>> {
        let folder = self.path(folder);
        self.store
            .list(Some(&folder))
            .map_err(Failure::from)
            .map_ok(|object| StorageObject {
                name: object
                    .location
                    .prefix_match(&folder)
                    .map(|parts| {
                        parts
                            .map(|part| part.as_ref().to_owned())
                            .collect::<Vec<_>>()
                            .join("/")
                    })
                    .unwrap_or_default(),
                bytes: object.size,
            })
            .try_collect()
            .await
    }

    pub(crate) async fn list_storage_folders(&self) -> Result<Vec<StorageFolder>> {
        let mut folders: HashMap<String, StorageFolder> = HashMap::new();
        let mut objects = self.store.list(Some(&self.prefix));
        while let Some(object) = objects.try_next().await? {
            let Some(folder_name) = object
                .location
                .prefix_match(&self.prefix)
                .and_then(|mut parts| parts.next())
                .map(|part| part.as_ref().to_owned())
            else {
                continue;
            };
            folders
                .entry(folder_name.clone())
                .or_insert_with(|| StorageFolder::empty(folder_name))
                .add(object.size, object.last_modified.timestamp_millis());
        }
        Ok(folders.into_values().collect())
    }

    /// A URL clients can download from directly, valid for `expires_in`.
    pub(crate) async fn create_download_url(
        &self,
        name: &str,
        expires_in: Duration,
    ) -> Result<String> {
        let url = self
            .signer
            .signed_url(Method::GET, &self.path(name), expires_in)
            .await?;
        Ok(url.into())
    }

    pub(crate) async fn clear(&self) -> Result<()> {
        self.delete_prefix(&self.prefix).await.map(|_deleted| ())
    }
}
