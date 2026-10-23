//! Internal failure type shared across modules.

/// Unexpected failure of an operation; expected outcomes are modeled as return values instead.
#[derive(Debug, thiserror::Error)]
pub(crate) enum Failure {
    #[error("database: {0}")]
    Db(#[from] sqlx::Error),
    #[error("storage: {0}")]
    ObjectStore(#[from] object_store::Error),
    #[error("query: {0}")]
    Query(#[from] sea_query::error::Error),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("http: {0}")]
    Http(#[from] reqwest::Error),
    #[error("token: {0}")]
    Token(#[from] jsonwebtoken::errors::Error),
    #[error("metrics: {0}")]
    Metrics(#[from] prometheus::Error),
    #[error("{0}")]
    Message(String),
}

impl Failure {
    pub(crate) fn msg(message: impl Into<String>) -> Self {
        Self::Message(message.into())
    }
}

pub(crate) type Result<T, E = Failure> = std::result::Result<T, E>;
