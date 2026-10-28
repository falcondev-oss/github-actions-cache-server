//! Typed configuration parsed from environment variables (or the matching flags).

use std::collections::HashMap;
use std::ffi::OsString;
use std::num::{NonZeroU16, NonZeroU64};
use std::path::PathBuf;
use std::time::Duration;

use clap::builder::Resettable;
use clap::{ArgAction, CommandFactory as _, FromArgMatches as _, Parser, ValueEnum};
use tokio::sync::Semaphore;
use url::Url;

#[derive(Debug, thiserror::Error)]
pub(crate) enum ConfigError {
    /// Also `--help` and `--version`; clap prints these itself.
    #[error(transparent)]
    Args(#[from] clap::Error),
    #[error("invalid configuration: {0}")]
    Invalid(String),
}

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
    /// `aud` values a token must carry one of; never empty, `None` skips the check.
    pub(crate) actions_token_audience: Option<Vec<String>>,
    /// How long unused entries are kept; `None` disables age-based cleanup.
    pub(crate) cache_retention: Option<Duration>,
    pub(crate) cache_max_size_bytes: Option<NonZeroU64>,
    pub(crate) cache_filesystem_max_usage: Percent,
    pub(crate) orphaned_storage_grace_period: Duration,
    pub(crate) disable_cleanup_jobs: bool,
    pub(crate) debug: bool,
    pub(crate) enable_direct_downloads: bool,
    /// Lifetime of a signed direct-download URL, 1 second to 1 hour.
    pub(crate) direct_download_url_ttl: Duration,
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

#[derive(Debug, Clone, Copy, ValueEnum)]
enum StorageDriver {
    S3,
    Filesystem,
    Gcs,
    Azblob,
}

#[derive(Debug, Clone, Copy, ValueEnum)]
enum DbDriver {
    Postgres,
    Mysql,
    Sqlite,
}

/// The integer `raw` denotes, also in float notation: Helm renders large numbers as
/// `1.073741824e+11`.
#[expect(
    clippy::as_conversions,
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    clippy::float_cmp,
    reason = "converts only floats that are exactly representable integers"
)]
fn integer<T: TryFrom<u64>>(raw: &str) -> Result<T, String> {
    const MAX_EXACT: f64 = 9_007_199_254_740_991.0;
    raw.trim()
        .parse::<f64>()
        .ok()
        .filter(|value| (0.0..=MAX_EXACT).contains(value) && value.trunc() == *value)
        .and_then(|value| T::try_from(value as u64).ok())
        .ok_or_else(|| format!("{raw:?} is not an integer in range"))
}

fn port(raw: &str) -> Result<NonZeroU16, String> {
    NonZeroU16::new(integer(raw)?).ok_or_else(|| "0 is not a port".to_owned())
}

fn url_ttl(raw: &str) -> Result<Duration, String> {
    Some(integer::<u64>(raw)?)
        .filter(|seconds| (1..=3600).contains(seconds))
        .map(Duration::from_secs)
        .ok_or_else(|| format!("{raw} is not between 1 and 3600"))
}

fn number(raw: &str) -> Result<f64, String> {
    raw.trim()
        .parse::<f64>()
        .ok()
        .filter(|number| number.is_finite())
        .ok_or_else(|| format!("{raw:?} is not a number"))
}

fn percent(raw: &str) -> Result<Percent, String> {
    Some(number(raw)?)
        .filter(|percent| *percent > 0.0 && *percent <= 100.0)
        .map(Percent)
        .ok_or_else(|| format!("{raw} is not greater than 0 and at most 100"))
}

/// Validates a URL but keeps its original spelling, which is concatenated with paths verbatim.
fn url_string(raw: &str) -> Result<String, url::ParseError> {
    Url::parse(raw)?;
    Ok(raw.to_owned())
}

#[expect(
    clippy::float_arithmetic,
    reason = "retention is configured in possibly fractional days"
)]
fn days(days: f64) -> Result<Option<Duration>, ConfigError> {
    if days == 0.0 {
        return Ok(None);
    }
    Duration::try_from_secs_f64(days * 24.0 * 60.0 * 60.0)
        .map(Some)
        .map_err(|_negative| {
            ConfigError::Invalid(format!(
                "CACHE_CLEANUP_OLDER_THAN_DAYS must be a non-negative number, got {days}"
            ))
        })
}

/// Every variable as given. An empty variable counts as unset.
#[derive(Debug, Parser)]
#[command(
    version,
    about,
    args_override_self = true,
    after_help = "Each option can also be set by the environment variable its value is named \
                  after, e.g. API_BASE_URL. An empty variable counts as unset."
)]
#[expect(
    clippy::struct_excessive_bools,
    reason = "independent flags, one per environment variable"
)]
struct Vars {
    /// Public base URL of this server, as runners reach it
    #[arg(long, env, value_parser = url_string)]
    api_base_url: String,
    /// Interface to listen on [default: all]
    #[arg(long, env)]
    host: Option<String>,
    #[arg(long, env, default_value = "3000", value_parser = port)]
    port: NonZeroU16,
    /// Origin of requests this server does not handle itself
    #[arg(
        long,
        env,
        default_value = "https://results-receiver.actions.githubusercontent.com",
        value_parser = url_string
    )]
    default_actions_results_url: String,
    #[arg(
        long,
        env,
        default_value = "https://token.actions.githubusercontent.com",
        value_parser = url_string
    )]
    actions_token_issuer: String,
    /// [default: discovered from the issuer]
    #[arg(long, env)]
    actions_token_jwks_url: Option<Url>,
    /// Comma-separated `aud` values a token must carry one of [default: not checked]
    #[arg(long, env)]
    actions_token_audience: Option<String>,
    #[arg(long, env, action = ArgAction::Set, default_value_t = false)]
    skip_token_validation: bool,
    /// Allows direct downloads with `SKIP_TOKEN_VALIDATION`; for local testing only
    #[arg(long, env, action = ArgAction::Set, default_value_t = false)]
    unsafe_allow_direct_downloads_without_token_validation: bool,
    /// Days an unused entry is kept; 0 keeps it forever
    #[arg(long, env, default_value = "90", value_parser = number)]
    cache_cleanup_older_than_days: f64,
    #[arg(long, env, value_parser = integer::<NonZeroU64>)]
    cache_max_size_bytes: Option<NonZeroU64>,
    #[arg(long, env, default_value = "90", value_parser = percent)]
    cache_filesystem_max_usage_percent: Percent,
    #[arg(long, env, default_value = "24", value_parser = integer::<NonZeroU64>)]
    orphaned_storage_grace_period_hours: NonZeroU64,
    #[arg(long, env, action = ArgAction::Set, default_value_t = false)]
    disable_cleanup_jobs: bool,
    /// Any value enables debug logging
    #[arg(long, env)]
    debug: Option<String>,
    #[arg(long, env, action = ArgAction::Set, default_value_t = false)]
    enable_direct_downloads: bool,
    /// Seconds a signed direct-download URL stays valid, 1 to 3600
    #[arg(long, env, default_value = "600", value_parser = url_ttl)]
    direct_download_url_ttl_seconds: Duration,
    #[arg(long, env, action = ArgAction::Set, default_value_t = false)]
    eager_merge: bool,
    #[arg(long, env, default_value = "16", value_parser = integer::<NonZeroU64>)]
    max_concurrent_merges: NonZeroU64,
    /// Milliseconds a download waits for its client to read; 0 waits forever
    #[arg(long, env, default_value = "300000", value_parser = integer::<i32>)]
    download_idle_timeout_ms: i32,
    /// Enables the management API
    #[arg(long, env)]
    management_api_key: Option<String>,

    #[arg(long, env, value_enum, default_value_t = StorageDriver::Filesystem)]
    storage_driver: StorageDriver,
    #[arg(long, env, default_value = ".data/storage/filesystem")]
    storage_filesystem_path: PathBuf,
    #[arg(long, env)]
    storage_s3_bucket: Option<String>,
    /// [default: 10000]
    #[arg(long, env)]
    storage_s3_socket_timeout_ms: Option<String>,
    #[arg(long, env, default_value = "us-east-1")]
    aws_region: String,
    #[arg(long, env)]
    aws_endpoint_url: Option<String>,
    #[arg(long, env)]
    aws_access_key_id: Option<String>,
    #[arg(long, env)]
    aws_secret_access_key: Option<String>,
    #[arg(long, env)]
    storage_gcs_bucket: Option<String>,
    #[arg(long, env)]
    storage_gcs_service_account_key: Option<PathBuf>,
    #[arg(long, env)]
    storage_gcs_endpoint: Option<String>,
    #[arg(long, env)]
    storage_azblob_container: Option<String>,
    #[arg(long, env)]
    storage_azblob_connection_string: Option<String>,
    #[arg(long, env)]
    storage_azblob_account: Option<String>,
    #[arg(long, env)]
    storage_azblob_endpoint: Option<String>,

    #[arg(long, env, value_enum, default_value_t = DbDriver::Sqlite)]
    db_driver: DbDriver,
    #[arg(long, env, default_value = ".data/sqlite.db")]
    db_sqlite_path: PathBuf,
    #[arg(long, env)]
    db_postgres_url: Option<String>,
    #[arg(long, env)]
    db_postgres_database: Option<String>,
    #[arg(long, env)]
    db_postgres_host: Option<String>,
    #[arg(long, env)]
    db_postgres_port: Option<String>,
    #[arg(long, env)]
    db_postgres_user: Option<String>,
    #[arg(long, env)]
    db_postgres_password: Option<String>,
    #[arg(long, env)]
    db_mysql_database: Option<String>,
    #[arg(long, env)]
    db_mysql_host: Option<String>,
    #[arg(long, env)]
    db_mysql_port: Option<String>,
    #[arg(long, env)]
    db_mysql_user: Option<String>,
    #[arg(long, env)]
    db_mysql_password: Option<String>,
}

fn required<T>(value: Option<T>, name: &str) -> Result<T, ConfigError> {
    value.ok_or_else(|| ConfigError::Invalid(format!("{name} is required")))
}

/// Driver-specific variables are only read for the selected driver, so stray ones (e.g.
/// Kubernetes service links) don't stop startup.
fn parsed<T, E: std::fmt::Display>(
    raw: Option<String>,
    name: &str,
    parse: impl FnOnce(&str) -> Result<T, E>,
) -> Result<Option<T>, ConfigError> {
    raw.map(|raw| parse(&raw).map_err(|error| ConfigError::Invalid(format!("{name}: {error}"))))
        .transpose()
}

fn absent<T>(values: &[(&Option<T>, &str)], reason: &str) -> Result<(), ConfigError> {
    values
        .iter()
        .find(|(value, _)| value.is_some())
        .map_or(Ok(()), |(_, name)| {
            Err(ConfigError::Invalid(format!(
                "{name} must not be set {reason}"
            )))
        })
}

fn server_connection(
    prefix: &str,
    [database, host, user, password]: [Option<String>; 4],
    port: Option<String>,
) -> Result<ServerConnection, ConfigError> {
    let name = |field: &str| format!("DB_{prefix}_{field}");
    Ok(ServerConnection {
        database: required(database, &name("DATABASE"))?,
        host: required(host, &name("HOST"))?,
        port: required(parsed(port, &name("PORT"), self::port)?, &name("PORT"))?,
        user: required(user, &name("USER"))?,
        password: password.unwrap_or_default(),
    })
}

impl Vars {
    fn storage(&mut self) -> Result<StorageConfig, ConfigError> {
        Ok(match self.storage_driver {
            StorageDriver::Filesystem => StorageConfig::Filesystem {
                path: std::mem::take(&mut self.storage_filesystem_path),
            },
            StorageDriver::S3 => StorageConfig::S3 {
                bucket: required(self.storage_s3_bucket.take(), "STORAGE_S3_BUCKET")?,
                socket_timeout: Duration::from_millis(
                    parsed(
                        self.storage_s3_socket_timeout_ms.take(),
                        "STORAGE_S3_SOCKET_TIMEOUT_MS",
                        integer::<u64>,
                    )?
                    .unwrap_or(10_000),
                ),
                region: std::mem::take(&mut self.aws_region),
                endpoint_url: parsed(self.aws_endpoint_url.take(), "AWS_ENDPOINT_URL", Url::parse)?,
                access_key_id: self.aws_access_key_id.take(),
                secret_access_key: self.aws_secret_access_key.take(),
            },
            StorageDriver::Gcs => StorageConfig::Gcs {
                bucket: required(self.storage_gcs_bucket.take(), "STORAGE_GCS_BUCKET")?,
                service_account_key: self.storage_gcs_service_account_key.take(),
                endpoint: parsed(
                    self.storage_gcs_endpoint.take(),
                    "STORAGE_GCS_ENDPOINT",
                    Url::parse,
                )?,
            },
            StorageDriver::Azblob => StorageConfig::AzBlob {
                container: required(
                    self.storage_azblob_container.take(),
                    "STORAGE_AZBLOB_CONTAINER",
                )?,
                auth: match self.storage_azblob_connection_string.take() {
                    Some(connection_string) => {
                        absent(
                            &[
                                (&self.storage_azblob_account, "STORAGE_AZBLOB_ACCOUNT"),
                                (&self.storage_azblob_endpoint, "STORAGE_AZBLOB_ENDPOINT"),
                            ],
                            "together with STORAGE_AZBLOB_CONNECTION_STRING",
                        )?;
                        AzBlobAuth::ConnectionString(connection_string)
                    }
                    None => AzBlobAuth::Account {
                        account: required(
                            self.storage_azblob_account.take(),
                            "STORAGE_AZBLOB_CONNECTION_STRING or STORAGE_AZBLOB_ACCOUNT",
                        )?,
                        endpoint: parsed(
                            self.storage_azblob_endpoint.take(),
                            "STORAGE_AZBLOB_ENDPOINT",
                            Url::parse,
                        )?,
                    },
                },
            },
        })
    }

    fn db(&mut self) -> Result<DbConfig, ConfigError> {
        Ok(match self.db_driver {
            DbDriver::Sqlite => DbConfig::Sqlite {
                path: std::mem::take(&mut self.db_sqlite_path),
            },
            DbDriver::Postgres => DbConfig::Postgres(match self.db_postgres_url.take() {
                Some(url) => {
                    absent(
                        &[
                            (&self.db_postgres_database, "DB_POSTGRES_DATABASE"),
                            (&self.db_postgres_host, "DB_POSTGRES_HOST"),
                            (&self.db_postgres_port, "DB_POSTGRES_PORT"),
                            (&self.db_postgres_user, "DB_POSTGRES_USER"),
                            (&self.db_postgres_password, "DB_POSTGRES_PASSWORD"),
                        ],
                        "together with DB_POSTGRES_URL",
                    )?;
                    PostgresConnection::Url(url)
                }
                None => PostgresConnection::Params(server_connection(
                    "POSTGRES",
                    [
                        self.db_postgres_database.take(),
                        self.db_postgres_host.take(),
                        self.db_postgres_user.take(),
                        self.db_postgres_password.take(),
                    ],
                    self.db_postgres_port.take(),
                )?),
            }),
            DbDriver::Mysql => DbConfig::Mysql(server_connection(
                "MYSQL",
                [
                    self.db_mysql_database.take(),
                    self.db_mysql_host.take(),
                    self.db_mysql_user.take(),
                    self.db_mysql_password.take(),
                ],
                self.db_mysql_port.take(),
            )?),
        })
    }
}

impl Config {
    /// Reads the process environment and command line; flags override variables.
    pub(crate) fn from_env() -> Result<Self, ConfigError> {
        Self::parse(std::env::vars(), std::env::args_os().skip(1))
    }

    /// Parses configuration from explicit variables alone.
    #[cfg(test)]
    pub(crate) fn from_vars(
        vars: impl IntoIterator<Item = (String, String)>,
    ) -> Result<Self, ConfigError> {
        Self::parse(vars, [])
    }

    /// Clap reads the environment when an argument is declared, so variables are handed to it
    /// as flags instead, which also lets tests pass their own.
    fn parse(
        vars: impl IntoIterator<Item = (String, String)>,
        args: impl IntoIterator<Item = OsString>,
    ) -> Result<Self, ConfigError> {
        let set: HashMap<String, String> = vars
            .into_iter()
            .filter(|(_, value)| !value.is_empty())
            .collect();
        let command = Vars::command();
        let from_vars: Vec<OsString> = command
            .get_arguments()
            .filter_map(|arg| {
                let value = set.get(arg.get_env()?.to_str()?)?;
                Some(format!("--{}={value}", arg.get_long()?).into())
            })
            .collect();
        let matches = command
            .mut_args(|arg| arg.env(Resettable::Reset))
            .try_get_matches_from(
                std::iter::once(OsString::from(env!("CARGO_PKG_NAME")))
                    .chain(from_vars)
                    .chain(args),
            )?;
        let mut given = Vars::from_arg_matches(&matches)?;
        // A signed URL is a storage credential; unverified claims must not obtain one.
        if given.enable_direct_downloads
            && given.skip_token_validation
            && !given.unsafe_allow_direct_downloads_without_token_validation
        {
            return Err(ConfigError::Invalid(
                "ENABLE_DIRECT_DOWNLOADS=true requires token validation, but \
                 SKIP_TOKEN_VALIDATION=true would hand signed storage URLs to unverified callers. \
                 Unset SKIP_TOKEN_VALIDATION, or set \
                 UNSAFE_ALLOW_DIRECT_DOWNLOADS_WITHOUT_TOKEN_VALIDATION=true for local testing only"
                    .to_owned(),
            ));
        }
        let actions_token_audience = given
            .actions_token_audience
            .take()
            .map(|raw| {
                let audience: Vec<String> = raw
                    .split(',')
                    .map(str::trim)
                    .filter(|entry| !entry.is_empty())
                    .map(str::to_owned)
                    .collect();
                // A typo must not silently switch the check off.
                if audience.is_empty() {
                    return Err(ConfigError::Invalid(
                        "ACTIONS_TOKEN_AUDIENCE lists no audience; unset it to skip the check"
                            .to_owned(),
                    ));
                }
                Ok(audience)
            })
            .transpose()?;
        let storage = given.storage()?;
        let db = given.db()?;
        let api_base_url = given.api_base_url.trim_end_matches('/').to_owned();
        let issuer = &given.actions_token_issuer;
        Ok(Self {
            host: given.host,
            port: given.port.get(),
            actions_token_issuer: issuer.strip_suffix('/').unwrap_or(issuer).to_owned(),
            api_base_url,
            default_actions_results_url: given.default_actions_results_url,
            actions_token_jwks_url: given.actions_token_jwks_url,
            actions_token_audience,
            cache_retention: days(given.cache_cleanup_older_than_days)?,
            cache_max_size_bytes: given.cache_max_size_bytes,
            cache_filesystem_max_usage: given.cache_filesystem_max_usage_percent,
            orphaned_storage_grace_period: Duration::from_hours(
                given.orphaned_storage_grace_period_hours.get(),
            ),
            disable_cleanup_jobs: given.disable_cleanup_jobs,
            debug: given.debug.is_some(),
            enable_direct_downloads: given.enable_direct_downloads,
            direct_download_url_ttl: given.direct_download_url_ttl_seconds,
            eager_merge: given.eager_merge,
            max_concurrent_merges: usize::try_from(given.max_concurrent_merges.get())
                .unwrap_or(usize::MAX)
                .min(Semaphore::MAX_PERMITS),
            // `i32` caps it like v9, at the largest delay a Node timer accepts.
            download_idle_timeout: Some(given.download_idle_timeout_ms.unsigned_abs())
                .filter(|millis| *millis != 0)
                .map(|millis| Duration::from_millis(millis.into())),
            skip_token_validation: given.skip_token_validation,
            management_api_key: given.management_api_key,
            storage,
            db,
        })
    }
}

#[cfg(test)]
mod tests;
