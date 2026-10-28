use super::*;

fn config(vars: &[(&str, &str)]) -> Result<Config, ConfigError> {
    Config::from_vars(
        std::iter::once(&("API_BASE_URL", "http://localhost:3000/"))
            .chain(vars)
            .map(|&(key, value)| (key.to_owned(), value.to_owned())),
    )
}

#[test]
fn defaults_to_sqlite_and_filesystem() {
    let config = config(&[]).unwrap();
    assert_eq!(
        config.api_base_url, "http://localhost:3000",
        "trailing slash is stripped"
    );
    assert!(
        matches!(config.db, DbConfig::Sqlite { .. }),
        "sqlite is the default"
    );
    assert!(
        matches!(config.storage, StorageConfig::Filesystem { .. }),
        "filesystem is the default"
    );
    assert_eq!(config.port, 3000, "default port");
    assert_eq!(
        config.cache_retention,
        Some(Duration::from_hours(24 * 90)),
        "90 days by default"
    );
    assert_eq!(
        config.orphaned_storage_grace_period,
        Duration::from_hours(24),
        "one day"
    );
}

#[test]
fn rejects_mixed_postgres_connection_forms() {
    let result = config(&[
        ("DB_DRIVER", "postgres"),
        ("DB_POSTGRES_URL", "postgres://localhost/db"),
        ("DB_POSTGRES_HOST", "localhost"),
    ]);
    assert!(result.is_err(), "url and discrete parameters are exclusive");
}

#[test]
fn rejects_mixed_azblob_auth() {
    let result = config(&[
        ("STORAGE_DRIVER", "azblob"),
        ("STORAGE_AZBLOB_CONTAINER", "c"),
        ("STORAGE_AZBLOB_CONNECTION_STRING", "AccountName=a"),
        ("STORAGE_AZBLOB_ACCOUNT", "a"),
    ]);
    assert!(
        result.is_err(),
        "connection string and account are exclusive"
    );
}

#[test]
fn rejects_non_boolean_flags() {
    assert!(
        config(&[("EAGER_MERGE", "yes")]).is_err(),
        "only true/false are booleans"
    );
}

#[test]
fn accepts_integers_in_float_notation() {
    let parsed = config(&[
        ("CACHE_MAX_SIZE_BYTES", "1.073741824e+11"),
        ("ORPHANED_STORAGE_GRACE_PERIOD_HOURS", "48.0"),
    ])
    .unwrap();
    assert_eq!(
        parsed.cache_max_size_bytes.map(NonZeroU64::get),
        Some(107_374_182_400),
        "Helm's float rendering"
    );
    assert_eq!(
        parsed.orphaned_storage_grace_period,
        Duration::from_hours(48),
        "whole float"
    );
    assert!(
        config(&[("CACHE_MAX_SIZE_BYTES", "1.5")]).is_err(),
        "fractions are not integers"
    );
    assert!(
        config(&[("CACHE_MAX_SIZE_BYTES", "0")]).is_err(),
        "must be positive"
    );
}

#[test]
fn empty_values_mean_unset() {
    let parsed = config(&[("MANAGEMENT_API_KEY", ""), ("PORT", ""), ("HOST", "")]).unwrap();
    assert_eq!(
        parsed.management_api_key, None,
        "an empty key disables the API"
    );
    assert_eq!(parsed.port, 3000, "empty port falls back to the default");
    assert_eq!(parsed.host, None, "empty host listens everywhere");
}

#[test]
fn bounds_merge_and_download_limits() {
    let defaults = config(&[]).unwrap();
    assert_eq!(defaults.max_concurrent_merges, 16, "default merge cap");
    assert_eq!(
        defaults.download_idle_timeout,
        Some(Duration::from_mins(5)),
        "default idle timeout"
    );
    assert!(
        config(&[("MAX_CONCURRENT_MERGES", "0")]).is_err(),
        "no merges"
    );
    let disabled = config(&[("DOWNLOAD_IDLE_TIMEOUT_MS", "0")]).unwrap();
    assert_eq!(disabled.download_idle_timeout, None, "0 disables it");
    assert!(
        config(&[("DOWNLOAD_IDLE_TIMEOUT_MS", "2147483648")]).is_err(),
        "beyond the original server's bound"
    );
}

#[test]
fn zero_retention_disables_age_cleanup() {
    let parsed = config(&[("CACHE_CLEANUP_OLDER_THAN_DAYS", "0")]).unwrap();
    assert_eq!(parsed.cache_retention, None, "0 days disables it");
    assert!(
        config(&[("CACHE_CLEANUP_OLDER_THAN_DAYS", "-1")]).is_err(),
        "negative retention"
    );
}

#[test]
fn ignores_variables_of_other_drivers() {
    assert!(
        config(&[
            ("DB_MYSQL_PORT", "tcp://10.0.0.1:3306"),
            ("DB_POSTGRES_URL", "postgres://localhost/db"),
            ("DB_POSTGRES_HOST", "localhost"),
            ("AWS_ENDPOINT_URL", "not a url"),
        ])
        .is_ok(),
        "sqlite and filesystem don't read them"
    );
    assert!(
        config(&[
            ("DB_DRIVER", "mysql"),
            ("DB_MYSQL_PORT", "tcp://10.0.0.1:3306")
        ])
        .is_err(),
        "the selected driver does"
    );
}

#[test]
fn direct_downloads_require_token_validation() {
    let unverified = [
        ("ENABLE_DIRECT_DOWNLOADS", "true"),
        ("SKIP_TOKEN_VALIDATION", "true"),
    ];
    assert!(config(&unverified).is_err(), "refused without the override");
    let overridden = [
        unverified.as_slice(),
        &[(
            "UNSAFE_ALLOW_DIRECT_DOWNLOADS_WITHOUT_TOKEN_VALIDATION",
            "true",
        )],
    ]
    .concat();
    assert!(config(&overridden).is_ok(), "allowed with the override");
}

#[test]
fn bounds_the_direct_download_url_lifetime() {
    assert_eq!(
        config(&[]).unwrap().direct_download_url_ttl,
        Duration::from_mins(10),
        "ten minutes by default"
    );
    for ttl in ["0", "3601", "1.5"] {
        assert!(
            config(&[("DIRECT_DOWNLOAD_URL_TTL_SECONDS", ttl)]).is_err(),
            "{ttl} is out of range"
        );
    }
}

#[test]
fn parses_the_token_audience() {
    assert_eq!(
        config(&[("ACTIONS_TOKEN_AUDIENCE", " a, ,b ")])
            .unwrap()
            .actions_token_audience,
        Some(vec!["a".to_owned(), "b".to_owned()]),
        "trimmed, blanks dropped"
    );
    assert!(
        config(&[("ACTIONS_TOKEN_AUDIENCE", " , ")]).is_err(),
        "an audience list without audiences is refused"
    );
}
