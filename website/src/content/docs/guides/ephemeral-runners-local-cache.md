---
title: Local GitHub Actions cache for ephemeral self-hosted runners, no workflow changes
description: 'Run ephemeral GitHub Actions runners with a persistent local cache. Replace GitHub''s hosted cache service with a self-hosted, API-compatible cache server. Works with official actions/cache, setup-node and BuildKit type=gha. Supports ARC, Docker, Kubernetes and local NVMe storage.'
sidebar:
  label: Ephemeral runners, local cache
---

**Self-hosted GitHub Actions caching without workflow changes.** Run ephemeral GitHub Actions runners with persistent local caching. Replace GitHub's hosted cache service with a self-hosted, API-compatible cache server. Works with official `actions/cache`, `setup-node` and BuildKit GitHub Actions caching. Supports ARC, Docker, Kubernetes and local NVMe storage.

## The problem

Ephemeral runners take one job and are destroyed. That is what you want for clean, reproducible builds, but it means:

- **The runner's disk is gone after every job.** Package caches, build caches and Docker layers start from zero.
- **`actions/cache` uploads to GitHub's cloud.** On github.com, the cache backend is GitHub's hosted service, even for self-hosted runners. Every restore downloads over the internet, and every save uploads.
- **A mounted cache volume needs workflow changes.** A `hostPath` volume only helps tools you point at it, so you edit every workflow to set `npm_config_cache`, `GOMODCACHE` and friends. `actions/cache` and `setup-node` caching still go to GitHub.

The fix is to **destroy the runner, not the cache**: keep the cache in a service next to the runners that speaks the same API as GitHub's.

## The architecture

```text
GitHub Actions (existing workflows, unchanged)
        │
        ▼
ephemeral runners (ARC, Docker or VMs), forked runner image
        │  CUSTOM_ACTIONS_RESULTS_URL=http://ci-cache.internal:3000/
        ▼
GitHub Actions Cache Server (cache API v2)
        │
        ▼
persistent local NVMe (filesystem storage, SQLite metadata)
```

Runners stay disposable. The cache lives on your server and every new runner restores it at local network speed.

## 1. Run the cache server on the NVMe host

```yaml title="docker-compose.yml"
services:
  cache:
    image: ghcr.io/falcondev-oss/github-actions-cache-server:latest
    restart: unless-stopped
    ports:
      - '3000:3000'
    environment:
      API_BASE_URL: http://ci-cache.internal:3000
      STORAGE_FILESYSTEM_PATH: /data/cache
      DB_SQLITE_PATH: /data/cache-server.db
      # 100 GiB budget, least recently used entries are evicted first
      CACHE_MAX_SIZE_BYTES: '107374182400'
    volumes:
      - /srv/ci-cache:/data
```

```bash
sudo mkdir -p /srv/ci-cache
docker compose up -d
```

Replace `ci-cache.internal` with a hostname or private IP every runner can reach. Restrict port 3000 to your CI network.

## 2. Start ephemeral runners with the forked image

The stock runner overwrites the cache URL on every job, so use the [forked runner image](https://github.com/falcondev-oss/github-actions-runner). It reads `CUSTOM_ACTIONS_RESULTS_URL` and skips self-update.

**On Kubernetes**, use Actions Runner Controller. The [ARC guide](/guides/actions-runner-controller) has the complete Helm values. The only change to a standard scale set:

```yaml title="runner-values.yaml"
template:
  spec:
    containers:
      - name: runner
        image: ghcr.io/falcondev-oss/actions-runner:latest
        command: ['/home/runner/run.sh']
        env:
          - name: CUSTOM_ACTIONS_RESULTS_URL
            value: http://ci-cache.internal:3000/
```

**Without Kubernetes**, start one container per job and register it with `--ephemeral`, e.g. from a systemd unit or a loop, or use the [GitHub Runner Scale Set Client](https://github.com/actions/scaleset). Each container takes one job, exits, and is replaced:

```bash
docker run --rm -e RUNNER_TOKEN \
  -e CUSTOM_ACTIONS_RESULTS_URL=http://ci-cache.internal:3000/ \
  ghcr.io/falcondev-oss/actions-runner:latest \
  sh -c './config.sh --url https://github.com/YOUR_ORG --token "$RUNNER_TOKEN" --ephemeral --unattended && ./run.sh'
```

:::caution
`CUSTOM_ACTIONS_RESULTS_URL` must end with a trailing slash.
:::

## 3. Keep your workflows

Nothing to change. These steps all hit the local server now:

```yaml
- uses: actions/setup-node@v6
  with:
    node-version: 24
    cache: npm

- uses: actions/cache@v4
  with:
    path: ~/.cargo/registry
    key: cargo-${{ hashFiles('Cargo.lock') }}

- uses: docker/build-push-action@v6
  with:
    cache-from: type=gha
    cache-to: type=gha,mode=max
```

Then [confirm the runners use the server](/troubleshooting#confirm-the-runner-uses-your-server). A misconfigured runner silently falls back to GitHub's cache.

## What you get

| Requirement | Result |
| --- | --- |
| Ephemeral runners, one job each | Yes |
| Cache persists across runners | Yes |
| Cache stored on local NVMe | Yes |
| Official `actions/cache` | Yes |
| `setup-*` caching | Yes |
| BuildKit `type=gha` | Yes |
| Workflow YAML changes | None |
| Shared across runner nodes | Yes, over the network |
| Stock runner binary | No, use the forked image or the binary patch |
| Artifacts stored locally | No, forwarded to GitHub |

## Caveats

- **The integration is unofficial.** GitHub does not support changing the cache endpoint. The forked runner tracks upstream releases, and GitHub requires runners to stay within about 30 days of the latest release, so update the image on a schedule.
- **Caching still needs cache steps.** The server serves the caches your workflows ask for. A workflow without `actions/cache` or a `setup-*` cache option has nothing to restore.
- **Trust boundary.** Only let mutually trusted workflows share a cache. Run untrusted pull requests on separate, VM-isolated runners.

## Related

- [Compare the GitHub Actions cache options](/guides/github-actions-cache-options): GitHub's cloud cache, a mounted volume and this server side by side
- [Benchmarks](/benchmarks): what local NVMe caching is worth
- [Storage drivers](/storage-drivers): move from one disk to S3, RustFS or MinIO
