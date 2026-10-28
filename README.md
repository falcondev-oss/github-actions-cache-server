# 🚀 GitHub Actions Cache Server

A self-hosted, drop-in replacement for GitHub's cache service, written in Rust. Point your self-hosted runners at it and every `actions/cache` step, `setup-*` cache and `docker buildx` `type=gha` cache stays on your own hardware. No workflow changes.

|                                 | GitHub Actions Cache Server |
| ------------------------------- | --------------------------- |
| Image size                      | 29 MB                       |
| Startup to healthy              | 0.5 s                       |
| Idle memory                     | 3 MiB                       |
| Upload (8 × 128 MiB, parallel)  | 2.3 GiB/s                   |
| First download                  | 7.9 GiB/s                   |
| Lookups (64 concurrent)         | 34,000/s, p99 7 ms          |
| Small save + restore (256 KiB)  | 1,143/s                     |

<sub>SQLite + filesystem on a Ryzen 9 5950X with NVMe. Reproduce with `cargo run --release --example benchmark`.</sub>

## Features

- 🔥 **Works with everything that uses the cache**: `actions/cache`, `actions/setup-node` & friends, BuildKit `type=gha`, any tool built on `@actions/cache`
- 🗄️ **Your storage**: filesystem, S3 (RustFS, MinIO, R2, ...), Google Cloud Storage or Azure Blob Storage
- 🐘 **Your database**: SQLite, PostgreSQL or MySQL
- 🔒 **Secure by default**: verifies the runner's OIDC token, scopes every cache to its repository, signs each upload URL
- ⚡ **Direct downloads**: optionally hand runners a signed storage URL so restores skip the server
- 🧹 **Runs itself**: age- and size-based eviction, orphan cleanup, self-healing when storage drifts
- 📊 **Observable**: Prometheus `/metrics`, `/health`, management API with OpenAPI docs
- ☸️ **Deploy anywhere**: multi-arch image (amd64/arm64), Docker Compose or Helm, GitHub Enterprise Server

## Quick start

**1. Run the server**

```yaml
services:
  cache-server:
    image: ghcr.io/falcondev-oss/github-actions-cache-server
    ports:
      - '3000:3000'
    environment:
      API_BASE_URL: http://localhost:3000
    volumes:
      - cache-data:/app/.data

volumes:
  cache-data:
```

**2. Point your runners at it**

Swap the runner image for our fork and set one variable:

```yaml
image: ghcr.io/falcondev-oss/actions-runner:latest
env:
  CUSTOM_ACTIONS_RESULTS_URL: http://cache-server:3000/
```

**3. There is no step 3.** Your workflows already use it.

## Documentation

👉 <https://gha-cache-server.falcondev.io/getting-started> 👈
