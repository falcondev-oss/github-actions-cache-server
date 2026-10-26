use std::borrow::Cow;
use std::sync::atomic::{AtomicU32, Ordering};

use sqlx::error::{DatabaseError, ErrorKind};

use super::*;

#[test]
fn server_urls_bracket_ipv6_and_pass_sockets() {
    let params = |host: &str| ServerConnection {
        database: "db".to_owned(),
        host: host.to_owned(),
        port: std::num::NonZeroU16::new(5432).unwrap(),
        user: "u".to_owned(),
        password: "p@ss%FF".to_owned(),
    };
    assert_eq!(
        server_url(Dialect::Postgres, &params("::1")).unwrap(),
        "postgres://u:p%40ss%25FF@[::1]:5432/db",
        "IPv6 literal"
    );
    assert_eq!(
        server_url(Dialect::Postgres, &params("/run/postgresql")).unwrap(),
        "postgres://u:p%40ss%25FF@localhost:5432/db?host=%2Frun%2Fpostgresql",
        "socket directory"
    );
    assert_eq!(
        server_url(Dialect::Mysql, &params("/run/mysqld/mysqld.sock")).unwrap(),
        "mysql://u:p%40ss%25FF@localhost:5432/db?socket=%2Frun%2Fmysqld%2Fmysqld.sock",
        "socket file"
    );
}

#[test]
fn sqlite_urls_keep_filenames() {
    use sqlx::sqlite::SqliteConnectOptions;
    let filename = |path: &str| {
        SqliteConnectOptions::from_str(&sqlite_url(Path::new(path), Access::ReadWrite))
            .unwrap()
            .get_filename()
            .to_owned()
    };
    assert_eq!(
        filename("/tmp/cache%2Fdb 1#?.sqlite"),
        Path::new("/tmp/cache%2Fdb 1#?.sqlite"),
        "absolute"
    );
    assert_eq!(
        filename("data/cache.db"),
        Path::new("data/cache.db"),
        "relative"
    );
    assert!(
        SqliteConnectOptions::from_str(&sqlite_url(Path::new(IN_MEMORY), Access::ReadWrite))
            .is_ok(),
        "in memory"
    );
}

#[derive(Debug, thiserror::Error)]
#[error("Deadlock found when trying to get lock")]
struct LockConflict(&'static str);

impl DatabaseError for LockConflict {
    fn message(&self) -> &'static str {
        "Deadlock found when trying to get lock"
    }

    fn code(&self) -> Option<Cow<'_, str>> {
        Some(Cow::Borrowed(self.0))
    }

    fn as_error(&self) -> &(dyn std::error::Error + Send + Sync + 'static) {
        self
    }

    fn as_error_mut(&mut self) -> &mut (dyn std::error::Error + Send + Sync + 'static) {
        self
    }

    fn into_error(self: Box<Self>) -> Box<dyn std::error::Error + Send + Sync + 'static> {
        self
    }

    fn kind(&self) -> ErrorKind {
        ErrorKind::Other
    }
}

fn conflict(code: &'static str) -> Failure {
    Failure::Db(sqlx::Error::Database(Box::new(LockConflict(code))))
}

async fn attempts(
    mut outcome: impl FnMut(u32) -> Result<&'static str>,
) -> (Result<&'static str>, u32) {
    let calls = AtomicU32::new(0);
    let result = retry_on_lock_conflict(|| {
        let call = calls.fetch_add(1, Ordering::SeqCst);
        std::future::ready(outcome(call))
    })
    .await;
    (result, calls.load(Ordering::SeqCst))
}

#[test]
fn hashes_reservations_like_json_stringify() {
    let identity = |key: &str, version: &str, scope: &str, repo_id: &str| EntryIdentity {
        key: key.to_owned(),
        version: version.to_owned(),
        scope: scope.to_owned(),
        repo_id: repo_id.to_owned(),
    };
    // Expected values from Node: sha256(JSON.stringify([key, version, scope, repoId])).
    assert_eq!(
        identity("k", "v", "refs/heads/main", "123").reservation_hash(),
        "368889f52b85df29800ec2fc541d9cabc7a6d458ae6d2f9aff8b9089ad687b9c",
        "plain strings"
    );
    assert_eq!(
        identity("Café-ü 🚀", "v\"1\\x", "s\n\t\u{1}\u{1f}/", "r\u{2028}").reservation_hash(),
        "ce7cc7ffb27b7bae72e437beb98081837c5501e72d6316e03a0bbf43f6a2bda1",
        "non-ASCII, quotes, backslashes and control characters"
    );
}

#[tokio::test]
async fn retries_a_deadlock_victim_until_it_succeeds() {
    let (result, calls) = attempts(|call| {
        if call == 0 {
            Err(conflict("40001"))
        } else {
            Ok("merged")
        }
    })
    .await;
    assert_eq!(result.unwrap(), "merged", "the retry succeeds");
    assert_eq!(calls, 2, "one retry");
}

#[tokio::test]
async fn gives_up_after_the_attempt_limit() {
    let (result, calls) = attempts(|_| Err(conflict("40P01"))).await;
    assert!(result.is_err(), "the last conflict is returned");
    assert_eq!(calls, RETRY_ATTEMPTS, "every attempt is used");
}

#[tokio::test]
async fn does_not_retry_other_failures() {
    let (result, calls) = attempts(|_| Err(Failure::msg("Merge lease was lost"))).await;
    assert!(result.is_err(), "the failure is returned");
    assert_eq!(calls, 1, "no retry");
}
