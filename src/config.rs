//! Typed configuration parsed from environment variables.

use std::collections::HashMap;
use std::num::{NonZeroU16, NonZeroU64};
use std::path::PathBuf;
use std::time::Duration;

use tokio::sync::Semaphore;
use url::Url;

#[derive(Debug, thiserror::Error)]
#[error("invalid configuration: {0}")]
pub(crate) struct ConfigError(String);

/// Fully validated server configuration.
#[derive(Debug, Clone)]
#[expect(
    clippy::struct_excessive_bools,
    reason = "independent flags, one per environment variable"
)]
pub(crate) struct Config {
    /// Interface to listen on; `None` listens on all of them.
    pub(crate) host: Option<String>,
    pub(crate) port: u16,
    /// Public base URL of this server, without trailing slashes.
    pub(crate) api_base_url: String,
    pub(crate) default_actions_results_url: String,
    /// OIDC issuer without trailing slash.
    pub(crate) actions_token_issuer: String,
    pub(crate) actions_token_jwks_url: Option<Url>,
    /// How long unused entries are kept; `None` disables age-based cleanup.
    pub(crate) cache_retention: Option<Duration>,
    pub(crate) cache_max_size_bytes: Option<NonZeroU64>,
    pub(crate) cache_filesystem_max_usage: Percent,
    pub(crate) orphaned_storage_grace_period: Duration,
    pub(crate) disable_cleanup_jobs: bool,
    pub(crate) debug: bool,
    pub(crate) enable_direct_downloads: bool,
    pub(crate) eager_merge: bool,
    /// Merges this process runs at once, eager or lazy; at least 1.
    pub(crate) max_concurrent_merges: usize,
    /// How long a response may wait for its client to read; `None` waits forever.
    pub(crate) download_idle_timeout: Option<Duration>,
    pub(crate) skip_token_validation: bool,
    /// Never empty; `None` disables the management API.
    pub(crate) management_api_key: Option<String>,
    pub(crate) storage: StorageConfig,
    pub(crate) db: DbConfig,
}

/// A percentage greater than 0 and at most 100.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Percent(f64);

impl Percent {
    /// `percent` of `total`, rounded down.
    #[expect(
        clippy::as_conversions,
        clippy::cast_possible_truncation,
        clippy::cast_precision_loss,
        clippy::cast_sign_loss,
        clippy::float_arithmetic,
        reason = "a share of a volume size; f64 is exact far beyond real volume sizes"
    )]
    pub(crate) fn of(self, total: u64) -> u64 {
        (total as f64 * self.0 / 100.0).floor() as u64
    }
}

#[derive(Debug, Clone)]
pub(crate) enum StorageConfig {
    S3 {
        bucket: String,
        socket_timeout: Duration,
        region: String,
        endpoint_url: Option<Url>,
        access_key_id: Option<String>,
        secret_access_key: Option<String>,
    },
    Filesystem {
        path: PathBuf,
    },
    Gcs {
        bucket: String,
        service_account_key: Option<PathBuf>,
        endpoint: Option<Url>,
    },
    AzBlob {
        container: String,
        auth: AzBlobAuth,
    },
}

#[derive(Debug, Clone)]
pub(crate) enum AzBlobAuth {
    ConnectionString(String),
    Account {
        account: String,
        endpoint: Option<Url>,
    },
}

#[derive(Debug, Clone)]
pub(crate) enum DbConfig {
    Postgres(PostgresConnection),
    Mysql(ServerConnection),
    Sqlite { path: PathBuf },
}

#[derive(Debug, Clone)]
pub(crate) enum PostgresConnection {
    Url(String),
    Params(ServerConnection),
}

#[derive(Debug, Clone)]
pub(crate) struct ServerConnection {
    pub(crate) database: String,
    pub(crate) host: String,
    pub(crate) port: NonZeroU16,
    pub(crate) user: String,
    pub(crate) password: String,
}

const DEFAULTS: [(&str, &str); 4] = [
    ("STORAGE_DRIVER", "filesystem"),
    ("STORAGE_FILESYSTEM_PATH", ".data/storage/filesystem"),
    ("DB_DRIVER", "sqlite"),
    ("DB_SQLITE_PATH", ".data/sqlite.db"),
];

#[expect(
    clippy::float_arithmetic,
    reason = "retention is configured in possibly fractional days"
)]
fn days_to_seconds(days: f64) -> f64 {
    days * 24.0 * 60.0 * 60.0
}

/// The integer a finite, whole, non-negative float denotes. Helm renders large numbers as
/// `1.073741824e+11`, which the original server accepted as the integer it is.
#[expect(
    clippy::as_conversions,
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    clippy::float_cmp,
    reason = "converts only floats that are exactly representable integers"
)]
fn exact_integer(value: f64) -> Option<u64> {
    const MAX_EXACT: f64 = 9_007_199_254_740_991.0;
    ((0.0..=MAX_EXACT).contains(&value) && value.trunc() == value).then_some(value as u64)
}

struct Vars(HashMap<String, String>);

impl Vars {
    fn get(&self, key: &str) -> Option<&str> {
        self.0.get(key).map(String::as_str)
    }

    /// Like [`Self::get`], but an empty value counts as unset.
    fn non_empty(&self, key: &str) -> Option<&str> {
        self.get(key).filter(|value| !value.is_empty())
    }

    fn required(&self, key: &str) -> Result<String, ConfigError> {
        self.get(key)
            .map(str::to_owned)
            .ok_or_else(|| ConfigError(format!("{key} is required")))
    }

    fn absent(&self, key: &str, reason: &str) -> Result<(), ConfigError> {
        match self.get(key) {
            Some(_) => Err(ConfigError(format!("{key} must not be set {reason}"))),
            None => Ok(()),
        }
    }

    fn number(&self, key: &str) -> Result<Option<f64>, ConfigError> {
        self.get(key)
            .map(|raw| {
                raw.trim()
                    .parse::<f64>()
                    .ok()
                    .filter(|number| number.is_finite())
                    .ok_or_else(|| ConfigError(format!("{key} must be a number, got {raw:?}")))
            })
            .transpose()
    }

    /// An integer that converts into `T`, e.g. a non-zero or narrower type.
    fn integer<T: TryFrom<u64>>(
        &self,
        key: &str,
        expected: &str,
    ) -> Result<Option<T>, ConfigError> {
        self.get(key)
            .map(|raw| {
                raw.trim()
                    .parse::<f64>()
                    .ok()
                    .and_then(exact_integer)
                    .and_then(|integer| T::try_from(integer).ok())
                    .ok_or_else(|| ConfigError(format!("{key} must be {expected}, got {raw:?}")))
            })
            .transpose()
    }

    fn port(&self, key: &str) -> Result<Option<NonZeroU16>, ConfigError> {
        let port: Option<u16> = self.integer(key, "a port between 1 and 65535")?;
        port.map(|port| {
            NonZeroU16::new(port)
                .ok_or_else(|| ConfigError(format!("{key} must be a port between 1 and 65535")))
        })
        .transpose()
    }

    fn url(&self, key: &str) -> Result<Option<Url>, ConfigError> {
        self.get(key)
            .map(|raw| {
                raw.parse().map_err(|_parse_error| {
                    ConfigError(format!("{key} must be a URL, got {raw:?}"))
                })
            })
            .transpose()
    }

    /// Validates a URL but keeps its original spelling, which is concatenated with paths verbatim.
    fn raw_url(&self, key: &str) -> Result<Option<&str>, ConfigError> {
        self.url(key)?;
        Ok(self.get(key))
    }

    fn boolean(&self, key: &str) -> Result<bool, ConfigError> {
        match self.get(key) {
            None | Some("false") => Ok(false),
            Some("true") => Ok(true),
            Some(other) => Err(ConfigError(format!(
                "{key} must be true or false, got {other:?}"
            ))),
        }
    }

    fn server_connection(&self, prefix: &str) -> Result<ServerConnection, ConfigError> {
        let key = |name: &str| format!("DB_{prefix}_{name}");
        Ok(ServerConnection {
            database: self.required(&key("DATABASE"))?,
            host: self.required(&key("HOST"))?,
            port: self
                .port(&key("PORT"))?
                .ok_or_else(|| ConfigError(format!("{} is required", key("PORT"))))?,
            user: self.required(&key("USER"))?,
            password: self.required(&key("PASSWORD"))?,
        })
    }

    fn storage(&self) -> Result<StorageConfig, ConfigError> {
        match self.required("STORAGE_DRIVER")?.as_str() {
            "s3" => Ok(StorageConfig::S3 {
                bucket: self.required("STORAGE_S3_BUCKET")?,
                socket_timeout: Duration::from_millis(
                    self.integer("STORAGE_S3_SOCKET_TIMEOUT_MS", "a non-negative integer")?
                        .unwrap_or(10_000),
                ),
                region: self.get("AWS_REGION").unwrap_or("us-east-1").to_owned(),
                endpoint_url: self.url("AWS_ENDPOINT_URL")?,
                access_key_id: self.get("AWS_ACCESS_KEY_ID").map(str::to_owned),
                secret_access_key: self.get("AWS_SECRET_ACCESS_KEY").map(str::to_owned),
            }),
            "filesystem" => Ok(StorageConfig::Filesystem {
                path: self.required("STORAGE_FILESYSTEM_PATH")?.into(),
            }),
            "gcs" => Ok(StorageConfig::Gcs {
                bucket: self.required("STORAGE_GCS_BUCKET")?,
                service_account_key: self
                    .get("STORAGE_GCS_SERVICE_ACCOUNT_KEY")
                    .map(PathBuf::from),
                endpoint: self.url("STORAGE_GCS_ENDPOINT")?,
            }),
            "azblob" => {
                let container = self.required("STORAGE_AZBLOB_CONTAINER")?;
                let auth =
                    if let Some(connection_string) = self.get("STORAGE_AZBLOB_CONNECTION_STRING") {
                        let reason = "together with STORAGE_AZBLOB_CONNECTION_STRING";
                        self.absent("STORAGE_AZBLOB_ACCOUNT", reason)?;
                        self.absent("STORAGE_AZBLOB_ENDPOINT", reason)?;
                        AzBlobAuth::ConnectionString(connection_string.to_owned())
                    } else {
                        AzBlobAuth::Account {
                            account: self
                                .get("STORAGE_AZBLOB_ACCOUNT")
                                .map(str::to_owned)
                                .ok_or_else(|| {
                                    ConfigError(
                                    "STORAGE_AZBLOB_CONNECTION_STRING or STORAGE_AZBLOB_ACCOUNT \
                                     is required"
                                        .to_owned(),
                                )
                                })?,
                            endpoint: self.url("STORAGE_AZBLOB_ENDPOINT")?,
                        }
                    };
                Ok(StorageConfig::AzBlob { container, auth })
            }
            other => Err(ConfigError(format!(
                "STORAGE_DRIVER must be one of s3, filesystem, gcs, azblob, got {other:?}"
            ))),
        }
    }

    fn db(&self) -> Result<DbConfig, ConfigError> {
        match self.required("DB_DRIVER")?.as_str() {
            "postgres" => match self.get("DB_POSTGRES_URL") {
                Some(url) => {
                    for name in ["DATABASE", "HOST", "PORT", "USER", "PASSWORD"] {
                        self.absent(
                            &format!("DB_POSTGRES_{name}"),
                            "together with DB_POSTGRES_URL",
                        )?;
                    }
                    Ok(DbConfig::Postgres(PostgresConnection::Url(url.to_owned())))
                }
                None => Ok(DbConfig::Postgres(PostgresConnection::Params(
                    self.server_connection("POSTGRES")?,
                ))),
            },
            "mysql" => Ok(DbConfig::Mysql(self.server_connection("MYSQL")?)),
            "sqlite" => Ok(DbConfig::Sqlite {
                path: self.required("DB_SQLITE_PATH")?.into(),
            }),
            other => Err(ConfigError(format!(
                "DB_DRIVER must be one of postgres, mysql, sqlite, got {other:?}"
            ))),
        }
    }

    fn retention(&self) -> Result<Option<Duration>, ConfigError> {
        let days = self
            .number("CACHE_CLEANUP_OLDER_THAN_DAYS")?
            .unwrap_or(90.0);
        if days == 0.0 {
            return Ok(None);
        }
        Duration::try_from_secs_f64(days_to_seconds(days))
            .map(Some)
            .map_err(|_negative| {
                ConfigError(format!(
                    "CACHE_CLEANUP_OLDER_THAN_DAYS must be a non-negative number, got {days}"
                ))
            })
    }

    fn download_idle_timeout(&self) -> Result<Option<Duration>, ConfigError> {
        // `i32` caps it like the original server, at the largest delay a Node timer accepts.
        let millis = self
            .integer::<i32>(
                "DOWNLOAD_IDLE_TIMEOUT_MS",
                "an integer between 0 and 2147483647",
            )?
            .map_or(300_000, i32::unsigned_abs);
        Ok((millis != 0).then(|| Duration::from_millis(millis.into())))
    }

    fn percent(&self, key: &str, default: f64) -> Result<Percent, ConfigError> {
        let percent = self.number(key)?.unwrap_or(default);
        if percent > 0.0 && percent <= 100.0 {
            Ok(Percent(percent))
        } else {
            Err(ConfigError(format!(
                "{key} must be greater than 0 and at most 100"
            )))
        }
    }
}

impl Config {
    /// Reads the process environment.
    pub(crate) fn from_env() -> Result<Self, ConfigError> {
        Self::from_vars(std::env::vars())
    }

    /// Parses configuration from explicit variables, on top of the built-in defaults.
    pub(crate) fn from_vars(
        overrides: impl IntoIterator<Item = (String, String)>,
    ) -> Result<Self, ConfigError> {
        let mut map: HashMap<String, String> = DEFAULTS
            .iter()
            .map(|&(key, value)| (key.to_owned(), value.to_owned()))
            .collect();
        map.extend(overrides);
        let vars = Vars(map);

        let api_base_url = vars
            .raw_url("API_BASE_URL")?
            .ok_or_else(|| ConfigError("API_BASE_URL is required".to_owned()))?;
        let actions_token_issuer = vars
            .raw_url("ACTIONS_TOKEN_ISSUER")?
            .unwrap_or("https://token.actions.githubusercontent.com");
        let orphan_grace_hours: u64 = vars
            .integer::<NonZeroU64>("ORPHANED_STORAGE_GRACE_PERIOD_HOURS", "an integer >= 1")?
            .map_or(24, NonZeroU64::get);

        Ok(Self {
            host: vars.non_empty("HOST").map(str::to_owned),
            port: match vars.non_empty("PORT") {
                Some(_) => vars.port("PORT")?,
                None => None,
            }
            .map_or(3000, NonZeroU16::get),
            api_base_url: api_base_url.trim_end_matches('/').to_owned(),
            default_actions_results_url: vars
                .raw_url("DEFAULT_ACTIONS_RESULTS_URL")?
                .unwrap_or("https://results-receiver.actions.githubusercontent.com")
                .to_owned(),
            actions_token_issuer: actions_token_issuer
                .strip_suffix('/')
                .unwrap_or(actions_token_issuer)
                .to_owned(),
            actions_token_jwks_url: vars.url("ACTIONS_TOKEN_JWKS_URL")?,
            cache_retention: vars.retention()?,
            cache_max_size_bytes: vars.integer("CACHE_MAX_SIZE_BYTES", "a positive integer")?,
            cache_filesystem_max_usage: vars.percent("CACHE_FILESYSTEM_MAX_USAGE_PERCENT", 90.0)?,
            orphaned_storage_grace_period: Duration::from_hours(orphan_grace_hours),
            disable_cleanup_jobs: vars.boolean("DISABLE_CLEANUP_JOBS")?,
            debug: vars.non_empty("DEBUG").is_some(),
            enable_direct_downloads: vars.boolean("ENABLE_DIRECT_DOWNLOADS")?,
            eager_merge: vars.boolean("EAGER_MERGE")?,
            max_concurrent_merges: vars
                .integer::<NonZeroU64>("MAX_CONCURRENT_MERGES", "an integer >= 1")?
                .map_or(16, |merges| {
                    usize::try_from(merges.get())
                        .unwrap_or(usize::MAX)
                        .min(Semaphore::MAX_PERMITS)
                }),
            download_idle_timeout: vars.download_idle_timeout()?,
            skip_token_validation: vars.boolean("SKIP_TOKEN_VALIDATION")?,
            management_api_key: vars.non_empty("MANAGEMENT_API_KEY").map(str::to_owned),
            storage: vars.storage()?,
            db: vars.db()?,
        })
    }
}

#[cfg(test)]
mod tests;
