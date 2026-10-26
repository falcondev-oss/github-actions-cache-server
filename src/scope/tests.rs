use axum::Router;
use axum::routing::get;

use super::*;

async fn issuer(discovery: axum::routing::MethodRouter) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let app = Router::new().route("/.well-known/openid-configuration", discovery);
    drop(tokio::spawn(
        async move { axum::serve(listener, app).await },
    ));
    url
}

fn verifier(issuer: String) -> TokenVerifier {
    let config = Config::from_vars([
        (
            "API_BASE_URL".to_owned(),
            "http://localhost:3000".to_owned(),
        ),
        ("ACTIONS_TOKEN_ISSUER".to_owned(), issuer),
    ])
    .unwrap();
    TokenVerifier::new(&config).unwrap()
}

#[test]
fn selects_keys_like_jose() {
    let jwk = |extra: serde_json::Value| {
        let mut key = serde_json::json!({ "kty": "RSA", "n": "AQAB", "e": "AQAB" });
        key.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        serde_json::from_value::<Jwk>(key).unwrap()
    };
    let ec = serde_json::from_value::<Jwk>(
        serde_json::json!({ "kty": "EC", "crv": "P-256", "x": "AA", "y": "AA" }),
    )
    .unwrap();
    let rs256 = Header::new(Algorithm::RS256);
    let with_kid = Header {
        kid: Some("k".to_owned()),
        ..Header::new(Algorithm::RS256)
    };

    assert!(
        selects(&jwk(serde_json::json!({})), &rs256),
        "plain RSA key"
    );
    assert!(!selects(&ec, &rs256), "key type must fit the algorithm");
    assert!(
        selects(&ec, &Header::new(Algorithm::ES256)),
        "P-256 for ES256"
    );
    assert!(
        !selects(&ec, &Header::new(Algorithm::ES384)),
        "curve must fit the algorithm"
    );
    assert!(
        !selects(&jwk(serde_json::json!({ "use": "enc" })), &rs256),
        "encryption key"
    );
    assert!(
        !selects(&jwk(serde_json::json!({ "key_ops": ["encrypt"] })), &rs256),
        "key_ops without verify"
    );
    assert!(
        !selects(&jwk(serde_json::json!({ "alg": "RS384" })), &rs256),
        "other alg"
    );
    assert!(
        !selects(&jwk(serde_json::json!({ "kid": "other" })), &with_kid),
        "other kid"
    );
    assert!(
        selects(
            &jwk(serde_json::json!({ "kid": "k", "use": "sig", "alg": "RS256" })),
            &with_kid
        ),
        "matching signing key"
    );
}

#[tokio::test]
async fn discovers_the_jwks_uri() {
    let url = issuer(get(|| async {
        axum::Json(serde_json::json!({
            "issuer": "https://token.actions.githubusercontent.com/octocat-inc",
            "jwks_uri": "https://token.actions.githubusercontent.com/.well-known/jwks",
        }))
    }))
    .await;
    assert_eq!(
        verifier(url).discover_jwks_url().await.unwrap(),
        "https://token.actions.githubusercontent.com/.well-known/jwks",
        "jwks_uri from the discovery document"
    );
}

#[tokio::test]
async fn fails_discovery_without_document_or_jwks_uri() {
    let missing = issuer(get(|| async {
        (axum::http::StatusCode::NOT_FOUND, "Not Found")
    }))
    .await;
    let not_served = verifier(missing)
        .discover_jwks_url()
        .await
        .unwrap_err()
        .to_string();
    assert!(
        not_served.contains("404"),
        "status is reported: {not_served}"
    );

    let incomplete = issuer(get(|| async {
        axum::Json(serde_json::json!({ "issuer": "x" }))
    }))
    .await;
    let no_uri = verifier(incomplete)
        .discover_jwks_url()
        .await
        .unwrap_err()
        .to_string();
    assert!(
        no_uri.contains("`jwks_uri`"),
        "missing jwks_uri is reported: {no_uri}"
    );
}
