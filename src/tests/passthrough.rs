//! Results Passthrough forwards unknown requests and their responses unchanged.

use std::sync::{Arc, Mutex};

use axum::body::Bytes;
use axum::http::{HeaderMap, Method, StatusCode, Uri};

use super::harness::TestServer;

#[derive(Debug, Clone)]
struct Captured {
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
}

#[tokio::test]
async fn forwards_unhandled_requests_to_the_results_origin() {
    let captured: Arc<Mutex<Vec<Captured>>> = Arc::default();
    let sink = Arc::clone(&captured);
    let origin = axum::Router::new().fallback(
        move |method: Method, uri: Uri, headers: HeaderMap, body: Bytes| {
            let sink = Arc::clone(&sink);
            async move {
                sink.lock().unwrap().push(Captured {
                    method,
                    uri,
                    headers,
                    body,
                });
                (
                    StatusCode::CONFLICT,
                    [
                        ("content-type", "application/json; charset=utf-8"),
                        ("x-results-origin", "fake"),
                    ],
                    r#"{"code":"already_exists","msg":"artifact already exists"}"#,
                )
            }
        },
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin_url = format!("http://{}", listener.local_addr().unwrap());
    drop(tokio::spawn(
        async move { axum::serve(listener, origin).await },
    ));

    let server = TestServer::with(&[("DEFAULT_ACTIONS_RESULTS_URL", &origin_url)]).await;
    let path = concat!(
        "/twirp/github.actions.results.api.v1.ArtifactService/CreateArtifact",
        "?api-version=6.0-preview.1",
    );
    let body = r#"{"name":"build-output","version":4}"#;
    let response = reqwest::Client::new()
        .post(format!("{}{path}", server.url))
        .header("authorization", "Bearer artifact-token")
        .header("content-type", "application/json")
        .header("x-artifact-request", "create")
        .body(body)
        .send()
        .await
        .unwrap();

    assert_eq!(response.status(), 409, "origin status");
    assert_eq!(
        response.headers()["content-type"],
        "application/json; charset=utf-8",
        "origin header"
    );
    assert_eq!(
        response.headers()["x-results-origin"],
        "fake",
        "origin header"
    );
    assert_eq!(
        response.text().await.unwrap(),
        r#"{"code":"already_exists","msg":"artifact already exists"}"#,
        "origin body"
    );

    let requests = captured.lock().unwrap().clone();
    assert_eq!(requests.len(), 1, "forwarded once");
    let request = &requests[0];
    assert_eq!(request.method, Method::POST, "method");
    assert_eq!(request.uri.to_string(), path, "path and query");
    assert_eq!(request.body, body, "body");
    for (name, value) in [
        ("authorization", "Bearer artifact-token"),
        ("content-type", "application/json"),
        ("x-artifact-request", "create"),
    ] {
        assert_eq!(request.headers[name], value, "{name} is forwarded");
    }
}

#[tokio::test]
async fn follows_redirects_of_the_results_origin() {
    let origin = axum::Router::new()
        .route(
            "/moved",
            axum::routing::get(|| async { axum::response::Redirect::temporary("/target") }),
        )
        .route("/target", axum::routing::get(|| async { "arrived" }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin_url = format!("http://{}", listener.local_addr().unwrap());
    drop(tokio::spawn(
        async move { axum::serve(listener, origin).await },
    ));

    let server = TestServer::with(&[("DEFAULT_ACTIONS_RESULTS_URL", &origin_url)]).await;
    let response = reqwest::get(format!("{}/moved", server.url)).await.unwrap();
    assert_eq!(response.status(), 200, "followed");
    assert_eq!(response.text().await.unwrap(), "arrived", "target body");
}
