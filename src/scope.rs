//! Authorization from the GitHub Actions runtime token (ADR-0006).

use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::http::HeaderMap;
use axum::http::header::AUTHORIZATION;
use jsonwebtoken::jwk::{Jwk, JwkSet};
use jsonwebtoken::{Algorithm, DecodingKey, Validation};
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

    async fn key(&self, http: &reqwest::Client, kid: Option<&str>) -> Result<Jwk> {
        let find = |set: &JwkSet| {
            kid.map_or_else(
                || match set.keys.as_slice() {
                    [only] => Some(only.clone()),
                    _ => None,
                },
                |kid| set.find(kid).cloned(),
            )
        };
        let missing = || Failure::msg("no matching key in JWKS");
        if let Some((set, fetched_at)) = self.cached.lock().await.as_ref() {
            let key = find(set);
            if let Some(key) = key.clone().filter(|_| fetched_at.elapsed() < JWKS_MAX_AGE) {
                return Ok(key);
            }
            // An unknown key refetches the set, but at most once per cooldown.
            if fetched_at.elapsed() < JWKS_COOLDOWN {
                return key.ok_or_else(missing);
            }
        }
        let set: JwkSet = http
            .get(&self.url)
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        let key = find(&set);
        *self.cached.lock().await = Some((set, Instant::now()));
        key.ok_or_else(missing)
    }
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
        let jwk = self
            .jwks()
            .await
            .key(&self.http, header.kid.as_deref())
            .await?;
        let algorithm = match jwk.common.key_algorithm {
            Some(key_algorithm) => Algorithm::try_from(key_algorithm)?,
            None => header.alg,
        };
        if algorithm != header.alg
            || matches!(
                algorithm,
                Algorithm::HS256 | Algorithm::HS384 | Algorithm::HS512
            )
        {
            return Err(Failure::msg(
                "token algorithm does not match the signing key",
            ));
        }
        let key = DecodingKey::from_jwk(&jwk)?;
        // Like the original server's `jose`: the issuer is required, `exp` and `nbf` are checked
        // when present without leeway, and the audience is not checked.
        let mut validation = Validation::new(algorithm);
        validation.set_issuer(&[&self.issuer]);
        validation.set_required_spec_claims(&["iss"]);
        validation.validate_nbf = true;
        validation.validate_aud = false;
        validation.leeway = 0;
        Ok(jsonwebtoken::decode::<Claims>(token, &key, &validation)?.claims)
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
