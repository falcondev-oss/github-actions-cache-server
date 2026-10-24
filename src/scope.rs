//! Authorization from the GitHub Actions runtime token (ADR-0006).

use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::http::HeaderMap;
use axum::http::header::AUTHORIZATION;
use jsonwebtoken::jwk::{
    AlgorithmParameters, EllipticCurve, Jwk, JwkSet, KeyOperations, PublicKeyUse,
};
use jsonwebtoken::{Algorithm, AlgorithmFamily, DecodingKey, Header, Validation};
use serde::Deserialize;
use tokio::sync::{Mutex, OnceCell};

use crate::config::Config;
use crate::error::{Failure, Result};

/// Permission bit that allows saving to a scope.
const WRITE_PERMISSION: i64 = 2;

/// A cache scope the token grants, with its permission bits.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub(crate) struct ScopeGrant {
    #[serde(rename = "Scope")]
    pub(crate) scope: String,
    #[serde(rename = "Permission")]
    pub(crate) permission: i64,
}

/// Scopes and repository a request may access.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CacheScope {
    /// Never empty.
    pub(crate) scopes: Vec<ScopeGrant>,
    pub(crate) repo_id: String,
}

impl CacheScope {
    pub(crate) fn write_scope(&self) -> Option<&ScopeGrant> {
        self.scopes
            .iter()
            .find(|grant| grant.permission >= WRITE_PERMISSION)
    }

    /// Scope names by descending permission, the order restores search them in.
    pub(crate) fn read_scopes(&self) -> Vec<String> {
        let mut grants = self.scopes.clone();
        grants.sort_by_key(|grant| std::cmp::Reverse(grant.permission));
        grants.into_iter().map(|grant| grant.scope).collect()
    }
}

/// Why a request was not authorized; always answered with 401.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub(crate) struct Unauthorized(pub(crate) &'static str);

#[derive(Debug, Deserialize)]
struct Claims {
    ac: Option<String>,
    repository_id: Option<String>,
}

/// Matches the original server's OIDC and JWKS fetch timeout.
const FETCH_TIMEOUT: Duration = Duration::from_secs(5);

const JWKS_MAX_AGE: Duration = Duration::from_mins(10);
const JWKS_COOLDOWN: Duration = Duration::from_secs(30);

/// A remote JWK set, cached and refetched when a token names an unknown key.
#[derive(Debug)]
struct RemoteJwks {
    url: String,
    cached: Mutex<Option<(JwkSet, Instant)>>,
}

impl RemoteJwks {
    fn new(url: String) -> Arc<Self> {
        Arc::new(Self {
            url,
            cached: Mutex::new(None),
        })
    }

    /// The keys that may have signed a token with `header`.
    async fn keys(&self, http: &reqwest::Client, header: &Header) -> Result<Vec<Jwk>> {
        let select = |set: &JwkSet| {
            set.keys
                .iter()
                .filter(|jwk| selects(jwk, header))
                .cloned()
                .collect::<Vec<_>>()
        };
        if let Some((set, fetched_at)) = self.cached.lock().await.as_ref() {
            let keys = select(set);
            // An unknown key refetches the set, but at most once per cooldown.
            if (!keys.is_empty() && fetched_at.elapsed() < JWKS_MAX_AGE)
                || fetched_at.elapsed() < JWKS_COOLDOWN
            {
                return Ok(keys);
            }
        }
        let set: JwkSet = http
            .get(&self.url)
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        let keys = select(&set);
        *self.cached.lock().await = Some((set, Instant::now()));
        Ok(keys)
    }
}

/// Whether `jwk` may verify a token with `header`, selected like the original server's `jose`: by
/// `kid`, key type and `alg`, and only among keys meant for verifying signatures.
fn selects(jwk: &Jwk, header: &Header) -> bool {
    let common = &jwk.common;
    let fits_algorithm = match (&jwk.algorithm, header.alg) {
        (AlgorithmParameters::RSA(_), alg) => alg.family() == AlgorithmFamily::Rsa,
        (AlgorithmParameters::EllipticCurve(key), Algorithm::ES256) => {
            key.curve == EllipticCurve::P256
        }
        (AlgorithmParameters::EllipticCurve(key), Algorithm::ES384) => {
            key.curve == EllipticCurve::P384
        }
        (AlgorithmParameters::OctetKeyPair(key), Algorithm::EdDSA) => {
            key.curve == EllipticCurve::Ed25519
        }
        _ => false,
    };
    fits_algorithm
        && header
            .kid
            .as_ref()
            .is_none_or(|kid| common.key_id.as_ref() == Some(kid))
        && common
            .public_key_use
            .as_ref()
            .is_none_or(|key_use| *key_use == PublicKeyUse::Signature)
        && common
            .key_operations
            .as_ref()
            .is_none_or(|operations| operations.contains(&KeyOperations::Verify))
        && common.key_algorithm.is_none_or(|algorithm| {
            Algorithm::try_from(algorithm).is_ok_and(|algorithm| algorithm == header.alg)
        })
}

/// Verifies runtime tokens against the configured issuer.
#[derive(Debug)]
pub(crate) struct TokenVerifier {
    issuer: String,
    skip_validation: bool,
    http: reqwest::Client,
    override_jwks: Option<Arc<RemoteJwks>>,
    discovered_jwks: OnceCell<Arc<RemoteJwks>>,
    fallback_jwks: Arc<RemoteJwks>,
}

impl TokenVerifier {
    pub(crate) fn new(config: &Config) -> Result<Self> {
        if config.skip_token_validation {
            tracing::warn!("token validation is disabled; this must not be used in production");
        }
        let issuer = config.actions_token_issuer.clone();
        Ok(Self {
            fallback_jwks: RemoteJwks::new(format!("{issuer}/.well-known/jwks")),
            override_jwks: config
                .actions_token_jwks_url
                .as_ref()
                .map(|url| RemoteJwks::new(url.to_string())),
            discovered_jwks: OnceCell::new(),
            skip_validation: config.skip_token_validation,
            issuer,
            http: reqwest::Client::builder().timeout(FETCH_TIMEOUT).build()?,
        })
    }

    /// The JWKS URL can't be derived from the issuer: an enterprise with a custom issuer value
    /// (`{host}/{enterpriseSlug}`) still serves its JWKS at `{host}`. Ask the OIDC discovery
    /// document instead.
    pub(crate) async fn discover_jwks_url(&self) -> Result<String> {
        #[derive(Deserialize)]
        struct Discovery {
            jwks_uri: Option<String>,
        }
        let url = format!("{}/.well-known/openid-configuration", self.issuer);
        let response = self.http.get(&url).send().await?;
        if !response.status().is_success() {
            return Err(Failure::msg(format!(
                "Unexpected status {}",
                response.status()
            )));
        }
        response
            .json::<Discovery>()
            .await?
            .jwks_uri
            .ok_or_else(|| Failure::msg(format!("Discovery document at {url} has no `jwks_uri`")))
    }

    async fn jwks(&self) -> Arc<RemoteJwks> {
        if let Some(jwks) = &self.override_jwks {
            return Arc::clone(jwks);
        }
        let discovered = self
            .discovered_jwks
            .get_or_try_init(|| async { self.discover_jwks_url().await.map(RemoteJwks::new) })
            .await;
        match discovered {
            Ok(jwks) => Arc::clone(jwks),
            Err(error) => {
                tracing::warn!(
                    %error,
                    fallback = self.fallback_jwks.url,
                    "OIDC discovery failed; set ACTIONS_TOKEN_JWKS_URL if validation keeps failing"
                );
                // Deliberately not cached, so the next request retries discovery instead of
                // pinning the process to a URL that may well be the wrong one.
                Arc::clone(&self.fallback_jwks)
            }
        }
    }

    async fn claims(&self, token: &str) -> Result<Claims> {
        if self.skip_validation {
            return Ok(jsonwebtoken::dangerous::insecure_decode::<Claims>(token)?.claims);
        }
        let header = jsonwebtoken::decode_header(token)?;
        let keys = self.jwks().await.keys(&self.http, &header).await?;
        // Like the original server's `jose`: the issuer is required, `exp` and `nbf` are checked
        // when present without leeway, and the audience is not checked.
        let mut validation = Validation::new(header.alg);
        validation.set_issuer(&[&self.issuer]);
        validation.set_required_spec_claims(&["iss"]);
        validation.validate_nbf = true;
        validation.validate_aud = false;
        validation.leeway = 0;
        // Without a `kid`, several keys can match; like `jose`, the first that verifies wins.
        let mut verified = Err(Failure::msg("no matching key in JWKS"));
        for jwk in &keys {
            verified = DecodingKey::from_jwk(jwk)
                .and_then(|key| jsonwebtoken::decode::<Claims>(token, &key, &validation))
                .map(|data| data.claims)
                .map_err(Failure::from);
            if verified.is_ok() {
                break;
            }
        }
        verified
    }

    /// Authorizes a request from its `Authorization: Bearer` runtime token.
    pub(crate) async fn cache_scope(
        &self,
        headers: &HeaderMap,
    ) -> Result<CacheScope, Unauthorized> {
        let token = headers
            .get(AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.strip_prefix("Bearer "))
            .ok_or(Unauthorized("Authorization header missing or malformed"))?;
        let claims = self.claims(token).await.map_err(|error| {
            tracing::debug!(%error, "invalid token");
            Unauthorized("Invalid token")
        })?;
        let Some(scopes) = claims.ac.filter(|ac| !ac.is_empty()) else {
            return Err(Unauthorized("Token does not contain cache scopes"));
        };
        let scopes: Vec<ScopeGrant> = serde_json::from_str(&scopes)
            .map_err(|_parse_error| Unauthorized("Invalid JSON in cache scopes"))?;
        if scopes.is_empty() {
            return Err(Unauthorized("Token does not contain any cache scopes"));
        }
        let Some(repo_id) = claims.repository_id.filter(|id| !id.is_empty()) else {
            return Err(Unauthorized("Token does not contain repository id"));
        };
        Ok(CacheScope { scopes, repo_id })
    }
}

#[cfg(test)]
mod tests {
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
}
