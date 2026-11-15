---
title: Getting started
description: 'Deploy the self-hosted GitHub Actions cache server with Docker Compose or Helm, point your self-hosted runners at it, and actions/cache, setup-* caches and BuildKit type=gha work unchanged.'
---

Three steps: run the server, point the runners at it, run a workflow. No workflow file changes.

## 1. Run the server

### Docker Compose

```yaml title="docker-compose.yml"
services:
  cache-server:
    image: ghcr.io/falcondev-oss/github-actions-cache-server
    restart: unless-stopped
    ports:
      - '3000:3000'
    environment:
      API_BASE_URL: http://cache-server.internal:3000
    volumes:
      - cache-data:/app/.data

volumes:
  cache-data:
```

`API_BASE_URL` is the URL your runners use to reach the server. Replace `cache-server.internal` with a hostname or IP every runner can reach. The defaults store payloads on the filesystem and metadata in SQLite, both under `/app/.data`. All options are on the [configuration](/configuration) page.

The image is a single static binary on [distroless](https://github.com/GoogleContainerTools/distroless), about 29 MB. It has no shell, so health checks must probe `GET /health` over HTTP instead of running a command inside the container.

### Kubernetes with Helm

The chart is published as an OCI artifact. It needs Helm 3.8 or later.

```bash
helm install cache-server oci://ghcr.io/falcondev-oss/charts/github-actions-cache-server
kubectl get deployments,svc
```

The deployment `cache-server-github-actions-cache-server` serves on port `3000`. Without `config.apiBaseUrl` the chart points runners at the internal service URL, which is what in-cluster runners need.

To customize, pass a `values.yaml`. All options are in the chart's [`values.yaml`](https://github.com/falcondev-oss/github-actions-cache-server/blob/dev/install/kubernetes/github-actions-cache-server/values.yaml).

```bash
helm install cache-server oci://ghcr.io/falcondev-oss/charts/github-actions-cache-server -f values.yaml
```

For runners managed by Actions Runner Controller, follow the [ARC guide](/guides/actions-runner-controller).

#### Graceful shutdown

On `SIGTERM` the server stops accepting connections, finishes in-flight requests and running merges, then exits. Ingress controllers learn about a removed pod asynchronously, so add a `preStop` sleep to keep serving until they do. The image has no shell, so use the native sleep handler (Kubernetes 1.30+) and set a grace period longer than the sleep:

```yaml title="values.yaml"
lifecycle:
  preStop:
    sleep:
      seconds: 30

terminationGracePeriodSeconds: 60
```

## 2. Point your runners at it

The stock runner overwrites `ACTIONS_RESULTS_URL` with GitHub's endpoint on every job. You need a runner that keeps your URL. [How it works](/how-it-works) explains why.

### Forked runner (recommended)

Use our forked runner image and set `CUSTOM_ACTIONS_RESULTS_URL`:

```yaml
image: ghcr.io/falcondev-oss/actions-runner:latest
env:
  CUSTOM_ACTIONS_RESULTS_URL: http://cache-server.internal:3000/
```

:::caution
`CUSTOM_ACTIONS_RESULTS_URL` must end with a trailing slash.
:::

- Repository: [falcondev-oss/github-actions-runner](https://github.com/falcondev-oss/github-actions-runner)
- Image: `ghcr.io/falcondev-oss/actions-runner:latest`

The forked image skips runner self-update while `CUSTOM_ACTIONS_RESULTS_URL` is set, so a server-triggered update cannot silently replace the patched binary and send your caches back to GitHub. You still update it yourself, see [keep the runner up to date](#keep-the-runner-up-to-date).

### Binary patch

If you build your own runner image, patch the binary so it overwrites a dummy variable instead of `ACTIONS_RESULTS_URL`. Then set `ACTIONS_RESULTS_URL` (with a trailing slash) on the runner.

```dockerfile title="Dockerfile"
FROM ghcr.io/actions/actions-runner:latest
# Modify runner binary to retain custom ACTIONS_RESULTS_URL
RUN sed -i 's/\x41\x00\x43\x00\x54\x00\x49\x00\x4F\x00\x4E\x00\x53\x00\x5F\x00\x52\x00\x45\x00\x53\x00\x55\x00\x4C\x00\x54\x00\x53\x00\x5F\x00\x55\x00\x52\x00\x4C\x00/\x41\x00\x43\x00\x54\x00\x49\x00\x4F\x00\x4E\x00\x53\x00\x5F\x00\x52\x00\x45\x00\x53\x00\x55\x00\x4C\x00\x54\x00\x53\x00\x5F\x00\x4F\x00\x52\x00\x4C\x00/g' /home/runner/bin/Runner.Worker.dll
```

```bash title="Linux"
sed -i 's/\x41\x00\x43\x00\x54\x00\x49\x00\x4F\x00\x4E\x00\x53\x00\x5F\x00\x52\x00\x45\x00\x53\x00\x55\x00\x4C\x00\x54\x00\x53\x00\x5F\x00\x55\x00\x52\x00\x4C\x00/\x41\x00\x43\x00\x54\x00\x49\x00\x4F\x00\x4E\x00\x53\x00\x5F\x00\x52\x00\x45\x00\x53\x00\x55\x00\x4C\x00\x54\x00\x53\x00\x5F\x00\x4F\x00\x52\x00\x4C\x00/g' /path_to_your_runner/bin/Runner.Worker.dll
```

```bash title="macOS"
gsed -i 's/\x41\x00\x43\x00\x54\x00\x49\x00\x4F\x00\x4E\x00\x53\x00\x5F\x00\x52\x00\x45\x00\x53\x00\x55\x00\x4C\x00\x54\x00\x53\x00\x5F\x00\x55\x00\x52\x00\x4C\x00/\x41\x00\x43\x00\x54\x00\x49\x00\x4F\x00\x4E\x00\x53\x00\x5F\x00\x52\x00\x45\x00\x53\x00\x55\x00\x4C\x00\x54\x00\x53\x00\x5F\x00\x4F\x00\x52\x00\x4C\x00/g' /path_to_your_runner/bin/Runner.Worker.dll
```

```powershell title="Windows"
[byte[]] -split (((Get-Content -Path ./bin/Runner.Worker.dll -Encoding Byte) | ForEach-Object ToString X2) -join '' -Replace '41004300540049004F004E0053005F0052004500530055004C00540053005F00550052004C00','41004300540049004F004E0053005F0052004500530055004C00540053005F004F0052004C00' -Replace '..', '0x$& ') | Set-Content -Path /path_to_your_runner/bin/Runner.Worker.dll -Encoding Byte
```

:::caution[Disable runner auto-update]
By default the runner self-updates when GitHub pushes a new version. That restores the stock binary and **silently sends your caches back to GitHub**. There is no error, the local cache just stops being used. Register the runner with `config.sh --disableupdate` to stop auto-updates. It works on github.com and GitHub Enterprise Server. The [forked runner](#forked-runner-recommended) does this for you.
:::

### Keep the runner up to date

GitHub requires self-hosted runners to stay current. If a runner falls more than about 30 days behind the latest release, or below GitHub's enforced minimum version, GitHub **stops queuing jobs to it**. Pull the latest forked runner image (or rebuild your patched image) and redeploy on a schedule.

:::tip
Install `zstd` on your runners. `actions/cache` then compresses and decompresses faster.
:::

## 3. Run a workflow

Your workflows already use the server. Every `actions/cache` step, every `setup-*` action with `cache:` set and every BuildKit `type=gha` cache now reads and writes your server.

```yaml title=".github/workflows/ci.yml"
jobs:
  test:
    runs-on: self-hosted
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-node@v6
        with:
          node-version: 24
          cache: npm # restored from your cache server
      - run: npm ci
```

Confirm that requests reach your server with the checks in [troubleshooting](/troubleshooting#confirm-the-runner-uses-your-server). A misconfigured runner falls back to GitHub's cache without an error.

## Next steps

- [Ephemeral runners with a local cache](/guides/ephemeral-runners-local-cache): the full architecture for disposable runners
- [Actions Runner Controller](/guides/actions-runner-controller): Helm values for ARC runner scale sets
- [Storage drivers](/storage-drivers) and [database drivers](/database-drivers): move from one host to S3 and Postgres
- [GitHub Enterprise Server](/guides/github-enterprise-server): the three extra settings GHES needs
