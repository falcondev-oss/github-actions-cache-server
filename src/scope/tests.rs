use axum::Router;
use axum::http::HeaderValue;
use axum::routing::get;
use base64::Engine as _;
use base64::prelude::BASE64_STANDARD;

use super::*;

async fn serve(app: Router) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    drop(tokio::spawn(
        async move { axum::serve(listener, app).await },
    ));
    url
}

async fn issuer(discovery: axum::routing::MethodRouter) -> String {
    serve(Router::new().route("/.well-known/openid-configuration", discovery)).await
}

fn verifier(vars: &[(&str, &str)]) -> TokenVerifier {
    let config = Config::from_vars(
        std::iter::once(&("API_BASE_URL", "http://localhost:3000"))
            .chain(vars)
            .map(|&(key, value)| (key.to_owned(), value.to_owned())),
    )
    .unwrap();
    TokenVerifier::new(&config).unwrap()
}

/// Ed25519 key pair for test tokens: the private key as base64 PKCS#8, the public key as JWK `x`.
const SIGNING_KEY: &str = "MC4CAQAwBQYDK2VwBCIEIIeuNgsi//Fdbe35Iso7yXEemjguYhGDxU1hANcjPSAY";
const PUBLIC_KEY_X: &str = "_UCvV5rHWyhUXvtwtOVx6QFdnhdlV6adbn87zLU2wyI";
const ISSUER: &str = "https://issuer.test";

/// A verifier that checks signatures against [`SIGNING_KEY`].
async fn signature_verifier(vars: &[(&str, &str)]) -> TokenVerifier {
    let jwks = serve(Router::new().route(
        "/jwks",
        get(|| async {
            axum::Json(serde_json::json!({
                "keys": [{ "kty": "OKP", "crv": "Ed25519", "x": PUBLIC_KEY_X }]
            }))
        }),
    ))
    .await;
    let jwks_url = format!("{jwks}/jwks");
    let mut vars = vars.to_vec();
    vars.extend([
        ("ACTIONS_TOKEN_ISSUER", ISSUER),
        ("ACTIONS_TOKEN_JWKS_URL", &jwks_url),
    ]);
    verifier(&vars)
}

/// Headers bearing a token signed with [`SIGNING_KEY`] and valid claims, with `changes` applied;
/// a `null` change removes the claim.
fn bearer(changes: &serde_json::Value) -> HeaderMap {
    let mut claims = serde_json::json!({
        "iss": ISSUER,
        "exp": jsonwebtoken::get_current_timestamp().saturating_add(600),
        "repository_id": "1",
        "ac": r#"[{"Scope":"refs/heads/main","Permission":3}]"#,
    });
    for (claim, value) in changes.as_object().unwrap() {
        if value.is_null() {
            claims.as_object_mut().unwrap().remove(claim);
        } else {
            claims[claim] = value.clone();
        }
    }
    let token = jsonwebtoken::encode(
        &Header::new(Algorithm::EdDSA),
        &claims,
        &jsonwebtoken::EncodingKey::from_ed_der(&BASE64_STANDARD.decode(SIGNING_KEY).unwrap()),
    )
    .unwrap();
    let mut headers = HeaderMap::new();
    headers.insert(
        AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {token}")).unwrap(),
    );
    headers
}

#[tokio::test]
async fn verified_tokens_need_exp_and_well_formed_scopes() {
    let verifier = signature_verifier(&[]).await;
    assert!(
        verifier
            .cache_scope(&bearer(&serde_json::json!({})))
            .await
            .is_ok(),
        "valid token"
    );
    assert!(
        verifier
            .cache_scope(&bearer(&serde_json::json!({ "aud": "anything" })))
            .await
            .is_ok(),
        "audience is not checked unless configured"
    );
    assert_eq!(
        verifier
            .cache_scope(&bearer(&serde_json::json!({ "exp": null })))
            .await,
        Err(Unauthorized("Invalid token")),
        "a token without exp never expires"
    );
    for ac in [
        r#"[{"Scope":"refs/heads/main","Permission":-1}]"#,
        r#"[{"Scope":"","Permission":1}]"#,
        r#"[{"Scope":"refs/heads/main"}]"#,
    ] {
        assert!(
            verifier
                .cache_scope(&bearer(&serde_json::json!({ "ac": ac })))
                .await
                .is_err(),
            "malformed scopes are rejected: {ac}"
        );
    }
}

#[tokio::test]
async fn a_configured_audience_is_required() {
    let verifier = signature_verifier(&[("ACTIONS_TOKEN_AUDIENCE", "a, b")]).await;
    for (aud, accepted) in [
        (serde_json::json!("b"), true),
        (serde_json::json!(["c", "a"]), true),
        (serde_json::json!("c"), false),
        (serde_json::Value::Null, false),
    ] {
        assert_eq!(
            verifier
                .cache_scope(&bearer(&serde_json::json!({ "aud": aud })))
                .await
                .is_ok(),
            accepted,
            "aud {aud}"
        );
    }
}

#[test]
fn permissions_are_bit_flags() {
    let grant = |scope: &str, permission| ScopeGrant {
        scope: scope.to_owned(),
        permission,
    };
    let scope = CacheScope {
        scopes: vec![grant("read", 1), grant("write", 2), grant("both", 3)],
        repo_id: "1".to_owned(),
    };
    assert_eq!(
        scope.read_scopes(),
        ["both", "read"],
        "write-only scopes are not read"
    );
    assert_eq!(
        scope.write_scope().map(|writable| writable.scope.as_str()),
        Some("write"),
        "read-only scopes are not written"
    );
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
        verifier(&[("ACTIONS_TOKEN_ISSUER", &url)])
            .discover_jwks_url()
            .await
            .unwrap(),
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
    let not_served = verifier(&[("ACTIONS_TOKEN_ISSUER", &missing)])
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
    let no_uri = verifier(&[("ACTIONS_TOKEN_ISSUER", &incomplete)])
        .discover_jwks_url()
        .await
        .unwrap_err()
        .to_string();
    assert!(
        no_uri.contains("`jwks_uri`"),
        "missing jwks_uri is reported: {no_uri}"
    );
}
