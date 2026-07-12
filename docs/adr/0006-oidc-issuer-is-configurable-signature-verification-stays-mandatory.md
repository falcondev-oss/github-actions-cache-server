---
status: proposed
---

# OIDC issuer is configurable; signature verification stays mandatory

GitHub Actions cache tokens are verified in `lib/scope.ts` against a hard-coded issuer and JWKS endpoint (`https://token.actions.githubusercontent.com`), which is correct for github.com but rejects every token issued by a GitHub Enterprise Server instance, whose Actions tokens carry the GHES host as their issuer. To support GHES (best-effort, per issue #241) we make the issuer configurable via a single env var defaulting to the current github.com value, and derive the JWKS URL from it as `{issuer}/.well-known/jwks` — the layout GHES inherits from the same Actions stack. github.com users change nothing.

We rejected the zero-code alternative of telling GHES operators to set `SKIP_TOKEN_VALIDATION=true`, because that flag disables signature verification entirely: any client that can reach the server could then forge scopes and read or poison any repository's cache. `SKIP_TOKEN_VALIDATION` stays what it is — a dev/test escape hatch, explicitly not a production deployment path. Keeping verification mandatory means a GHES deployment is exactly as authenticated as a github.com one, at the cost of the operator supplying their issuer. We deliberately derive the JWKS URL rather than accept it as a second var; if a real GHES layout ever splits the JWKS host from the issuer host, an explicit override can be added then.
