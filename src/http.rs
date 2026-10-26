//! HTTP error responses, request logging and the connection listener.

use std::io;
use std::net::SocketAddr;
use std::pin::Pin;
use std::time::Duration;

use axum::extract::Request;
use axum::http::StatusCode;
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::serve::Listener;
use tokio::net::{TcpListener, TcpStream};
use tokio_io_timeout::TimeoutStream;

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

/// Accepts connections that are closed once a response has waited `timeout` for the client to
/// read. The HTTP server has no such timeout and stops polling a response body while its writes
/// are blocked, so without it a client that stops reading but keeps the connection open holds a
/// download's storage read, its Storage Reader Lease and, on a first restore, the Merge it paces
/// forever. Bytes moving at any rate keep the connection alive.
#[derive(Debug)]
pub(crate) struct StalledClientListener {
    pub(crate) listener: TcpListener,
    /// `None` waits forever.
    pub(crate) timeout: Option<Duration>,
}

impl Listener for StalledClientListener {
    type Addr = SocketAddr;
    type Io = Pin<Box<TimeoutStream<TcpStream>>>;

    async fn accept(&mut self) -> (Self::Io, Self::Addr) {
        let (stream, address) = Listener::accept(&mut self.listener).await;
        let mut stream = TimeoutStream::new(stream);
        stream.set_write_timeout(self.timeout);
        (Box::pin(stream), address)
    }

    fn local_addr(&self) -> io::Result<Self::Addr> {
        self.listener.local_addr()
    }
}
