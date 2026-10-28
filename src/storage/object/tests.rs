use axum::body::{Body, Bytes};
use axum::http::StatusCode;
use axum::response::Response;
use axum::routing::put;

use super::*;

const TIMEOUT: Duration = Duration::from_millis(500);

async fn serve(app: axum::Router) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/", listener.local_addr().unwrap());
    drop(tokio::spawn(
        async move { axum::serve(listener, app).await },
    ));
    url
}

async fn upload(url: &str, body: ByteStream) -> Result<()> {
    let request = reqwest::Client::new().put(url);
    tokio::time::timeout(
        Duration::from_secs(5),
        upload_watched(request, body, Some(TIMEOUT)),
    )
    .await
    .unwrap()
}

#[tokio::test]
async fn a_slow_but_progressing_upload_does_not_time_out() {
    let url = serve(axum::Router::new().route("/", put(|_: Bytes| async {}))).await;
    // Four times the timeout in total, never silent for half of it.
    let body = stream::iter(0..8)
        .then(|_| async {
            tokio::time::sleep(TIMEOUT / 4).await;
            Ok(Bytes::from_static(b"chunk"))
        })
        .boxed();
    upload(&url, body).await.unwrap();
}

#[tokio::test]
async fn a_stalled_error_body_times_out() {
    let url = serve(axum::Router::new().route(
        "/",
        put(|| async {
            let body = stream::once(async { Ok::<_, io::Error>(Bytes::from_static(b"x")) })
                .chain(stream::pending());
            Response::builder()
                .status(StatusCode::INTERNAL_SERVER_ERROR)
                .header(CONTENT_LENGTH, 1000)
                .body(Body::from_stream(body))
                .unwrap()
        }),
    ))
    .await;
    let body = stream::once(async { Ok(Bytes::from_static(b"data")) }).boxed();
    assert!(upload(&url, body).await.is_err());
}
