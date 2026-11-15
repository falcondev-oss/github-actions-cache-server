---
title: 'GitHub Actions caching: GitHub cloud vs hostPath vs a local cache server'
description: 'Compare the three ways to cache on self-hosted GitHub Actions runners: GitHub''s hosted cache, a mounted hostPath or persistent volume, and a self-hosted cache server compatible with actions/cache. Which works with ephemeral runners, local NVMe and unchanged workflows.'
sidebar:
  label: Compare cache options
---

Self-hosted runners have three ways to keep caches between jobs. They differ in where the bytes live, and in whether your workflows have to change.

## At a glance

| | GitHub's hosted cache | Mounted volume (`hostPath`, PVC) | Local cache server |
| --- | --- | --- | --- |
| Where the cache lives | GitHub's cloud | One node's disk | Your server, any storage |
| Workflow changes | None | Every workflow sets cache paths | None |
| `actions/cache`, `setup-*` caching | Yes | No, they still go to GitHub | Yes |
| BuildKit `type=gha` | Yes | No | Yes |
| Ephemeral runners | Yes | Only on the same node | Yes |
| Restore speed | Internet bandwidth | Local disk | Local network, 7.9 GiB/s measured |
| Shared across nodes | Yes | No | Yes |
| Size limit | 10 GB per repository by default | Disk size | Your budget, LRU eviction |
| Per-repository isolation | Yes | No, one shared directory | Yes, verified per token |
| Concurrent writers | Safe | Depends on the tool | Safe |
| Runner binary | Stock | Stock | [Forked or patched](/getting-started#2-point-your-runners-at-it) |

## GitHub's hosted cache

The default. `actions/cache` on github.com stores data in GitHub's cloud, also when the runner is self-hosted. It needs no setup and isolates repositories. Every restore is a download over the internet, and every save an upload. For large caches or many jobs per hour, the transfer time can exceed the time the cache saves. On a self-hosted runner in your own datacenter, that traffic leaves your network twice per job.

## A mounted volume

Mount a host directory into every runner (`hostPath` in Kubernetes, a bind mount in Docker) and point each tool at it, e.g. `npm_config_cache: /cache/npm`. Access is local disk speed, with nothing to restore or upload.

The cost is in the details:

- Every workflow sets tool-specific cache paths. `actions/cache` and `setup-*` caching keep going to GitHub.
- The cache exists on one node. A job scheduled on another node starts cold.
- All repositories share one writable directory. One workflow can read or poison another's cache.
- Tools must cope with concurrent jobs writing the same directory.

It fits a single machine that runs a few trusted repositories with tools you control.

## A local cache server

Run a service that implements GitHub's cache API and point the runners at it. This is what the [GitHub Actions Cache Server](/) does. Workflows keep their `actions/cache` and `setup-*` steps, the bytes stay on your hardware, every node shares the cache, and each repository only sees its own entries.

The cost is one extra service and a runner that keeps your cache URL: the [forked runner image](https://github.com/falcondev-oss/github-actions-runner) or a one-line binary patch.

## Which to choose

- **GitHub-hosted runners:** GitHub's hosted cache. Nothing else applies.
- **Self-hosted runners, small caches, few jobs:** GitHub's hosted cache is fine.
- **Ephemeral runners, local caching, unchanged workflows:** a local cache server. See [ephemeral runners with a local cache](/guides/ephemeral-runners-local-cache).
- **One persistent machine, one trusted repository, tools you control:** a mounted volume is the least moving parts.

The approaches combine. A local cache server for `actions/cache`, plus a persistent BuildKit daemon or registry cache for very large Docker builds, is a common setup.
