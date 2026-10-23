//! HTTP error responses and request logging.

use axum::extract::Request;
use axum::http::StatusCode;
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};

use crate::error::Failure;

/// An error answered with an HTTP status and a JSON body.
#[derive(Debug)]
pub(crate) struct HttpError {
    status: StatusCode,
    message: String,
}

impl HttpError {
    pub(crate) fn new(status: StatusCode, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
        }
    }

    pub(crate) fn bad_request(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, message)
    }
}

impl From<Failure> for HttpError {
    fn from(failure: Failure) -> Self {
        tracing::error!(error = %failure, "request failed");
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error")
    }
}

impl IntoResponse for HttpError {
    fn into_response(self) -> Response {
        let body = serde_json::json!({
            "statusCode": self.status.as_u16(),
            "statusMessage": self.status.canonical_reason().unwrap_or_default(),
            "message": self.message,
        });
        (self.status, axum::Json(body)).into_response()
    }
}

/// Logs every request and its response status at debug level.
pub(crate) async fn log_requests(request: Request, next: Next) -> Response {
    let (method, path) = (request.method().clone(), request.uri().path().to_owned());
    tracing::debug!("Request: {method} {path}");
    let response = next.run(request).await;
    tracing::debug!("Response: {method} {path} > {}", response.status().as_u16());
    response
}
