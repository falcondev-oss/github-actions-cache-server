---
title: GitHub Enterprise Server
description: 'Run the self-hosted GitHub Actions cache server with GitHub Enterprise Server (GHES): enable cache service v2, point token validation at your instance and forward artifacts to your Results host.'
sidebar:
  label: GitHub Enterprise Server
---

GHES is supported on a best-effort basis. The server implements the **v2** cache protocol only, and GHES hard-codes a few values differently from github.com. A GHES deployment needs three settings on top of the [standard setup](/getting-started).

## 1. Enable cache service v2

The runner only talks to `ACTIONS_RESULTS_URL`, and so to the cache server, when GitHub sets `ACTIONS_CACHE_SERVICE_V2=true` on it. If your GHES version does not enable v2, the runner falls back to the legacy v1 protocol, which the cache server does not implement, and caching does not work. Check for `ACTIONS_CACHE_SERVICE_V2` in the runner's environment to confirm v2 is active.

:::caution
`ACTIONS_CACHE_URL` is the legacy v1 endpoint and is **not** used by the cache server. Setting it has no effect.
:::

## 2. Point token validation at your instance

GHES issues runner tokens from your own host. Set [`ACTIONS_TOKEN_ISSUER`](/configuration#actions_token_issuer) to your instance's issuer, the exact `iss` claim of a runner's OIDC token (decode one to confirm the value). The signing keys are then discovered from that issuer. If your instance serves neither a discovery document nor `{issuer}/.well-known/jwks`, point [`ACTIONS_TOKEN_JWKS_URL`](/configuration#actions_token_jwks_url) at the right endpoint. Without a matching issuer, every request is rejected with `401 Invalid token`.

## 3. Forward passthrough requests to your instance

Set [`DEFAULT_ACTIONS_RESULTS_URL`](/configuration#default_actions_results_url) to your instance's Results host, e.g. `https://results-receiver.actions.<your-ghes-host>`. Otherwise artifact uploads and downloads and other passthrough requests are forwarded to github.com and fail.

```yaml title="docker-compose.yml"
environment:
  API_BASE_URL: http://cache-server.internal:3000
  ACTIONS_TOKEN_ISSUER: https://<your-ghes-host>/_services/token
  DEFAULT_ACTIONS_RESULTS_URL: https://results-receiver.actions.<your-ghes-host>
```

The issuer above is the common GHES value. Use the `iss` claim from your own token if it differs.
