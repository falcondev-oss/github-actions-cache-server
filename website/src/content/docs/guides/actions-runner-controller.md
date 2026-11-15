---
title: Actions Runner Controller (ARC) with a local cache
description: 'Complete tutorial: ephemeral GitHub Actions runners on Kubernetes with Actions Runner Controller (ARC) runner scale sets and a self-hosted cache server on local NVMe. Helm values included, actions/cache workflows stay unchanged.'
sidebar:
  label: Actions Runner Controller
---

This tutorial sets up ephemeral runners with [Actions Runner Controller](https://docs.github.com/en/actions/concepts/runners/actions-runner-controller) (ARC) runner scale sets and a cache server on local NVMe. Each job gets a fresh runner pod. The cache survives every pod, and no workflow file changes.

```text
GitHub job queue
      │
      ▼
ARC listener (arc-systems) ── scales ──▶ runner pods (arc-runners), one job each
                                            │  CUSTOM_ACTIONS_RESULTS_URL
                                            ▼
                               cache server (gha-cache) ──▶ local NVMe volume
```

You need a Kubernetes cluster, Helm 3.8 or later, and a [GitHub App](https://docs.github.com/en/actions/tutorials/use-actions-runner-controller/authenticate-to-the-api) (or a personal access token) that can manage runners.

## 1. Install the cache server on the NVMe node

Pin the server to the node with the fast disk and give it a volume on that disk. Any storage class backed by local disks works, e.g. `local-path` on k3s or a local PV.

```yaml title="cache-values.yaml"
config:
  # 200 GiB budget, least recently used entries are evicted first
  cacheMaxSizeBytes: 214748364800

persistentVolumeClaim:
  storage: 250Gi
  storageClassName: local-path

nodeSelector:
  kubernetes.io/hostname: ci-node-1
```

```bash
helm install cache-server oci://ghcr.io/falcondev-oss/charts/github-actions-cache-server \
  --namespace gha-cache --create-namespace \
  -f cache-values.yaml
```

The chart points `API_BASE_URL` at its in-cluster service, `http://cache-server-github-actions-cache-server.gha-cache.svc.cluster.local:3000`. Runner pods use the same address.

:::tip[Several nodes or replicas]
For runners on many nodes, a single cache server on one NVMe node still serves all of them over the network. For several cache server replicas, use [S3 compatible storage](/storage-drivers/s3) and [PostgreSQL](/database-drivers/postgres) instead of the filesystem and SQLite.
:::

## 2. Install the ARC controller

```bash
helm install arc \
  --namespace arc-systems --create-namespace \
  oci://ghcr.io/actions/actions-runner-controller-charts/gha-runner-scale-set-controller

kubectl create namespace arc-runners
kubectl -n arc-runners create secret generic arc-auth \
  --from-literal=github_app_id="$GITHUB_APP_ID" \
  --from-literal=github_app_installation_id="$GITHUB_APP_INSTALLATION_ID" \
  --from-file=github_app_private_key=private-key.pem
```

## 3. Create the runner scale set with the forked runner

Replace the runner image with the [forked runner](https://github.com/falcondev-oss/github-actions-runner) and set `CUSTOM_ACTIONS_RESULTS_URL`. Nothing else changes.

```yaml title="runner-values.yaml"
githubConfigUrl: https://github.com/YOUR_ORG
githubConfigSecret: arc-auth

# keep two idle runners so jobs start right away
minRunners: 2
maxRunners: 10

template:
  spec:
    containers:
      - name: runner
        image: ghcr.io/falcondev-oss/actions-runner:latest
        command: ['/home/runner/run.sh']
        env:
          - name: CUSTOM_ACTIONS_RESULTS_URL
            # the trailing slash is required
            value: http://cache-server-github-actions-cache-server.gha-cache.svc.cluster.local:3000/
```

```bash
helm install ci-ephemeral \
  --namespace arc-runners \
  -f runner-values.yaml \
  oci://ghcr.io/actions/actions-runner-controller-charts/gha-runner-scale-set
```

The forked image skips runner self-update while `CUSTOM_ACTIONS_RESULTS_URL` is set. Bump the image tag on a schedule, GitHub stops sending jobs to runners that fall about 30 days behind.

## 4. Run your existing workflows

The installation name is the `runs-on` label. The workflow below is an ordinary workflow. Its caches now go to your NVMe node.

```yaml title=".github/workflows/ci.yml"
jobs:
  test:
    runs-on: ci-ephemeral
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-node@v6
        with:
          node-version: 24
          cache: npm
      - uses: actions/cache@v4
        with:
          path: .turbo
          key: turbo-${{ github.sha }}
          restore-keys: turbo-
      - run: npm ci
      - run: npm test
```

## 5. Confirm the cache is local

```bash
kubectl -n gha-cache port-forward svc/cache-server-github-actions-cache-server 3000:3000 &
curl -s localhost:3000/metrics | grep -E 'cache_(requests_total|uploads_total|storage_bytes)'
```

`cache_requests_total` goes up with every cache step. If it stays at zero, see [troubleshooting](/troubleshooting).

## Docker builds

BuildKit's `type=gha` cache goes through the same server. Run the scale set with `containerMode: { type: dind }` (privileged pods) and use `docker/build-push-action` with `cache-from: type=gha` and `cache-to: type=gha,mode=max`. The action passes the runner's cache URL to BuildKit, so layers land on your NVMe node too.

## Security

Ephemeral containers give each job a clean environment, not the isolation of a separate VM. Run untrusted pull requests on separate runners, and only let mutually trusted workflows share a cache: a job can write any entry in its own branch scope.
