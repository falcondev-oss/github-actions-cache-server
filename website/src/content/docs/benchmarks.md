---
title: Benchmarks
description: 'Reproducible benchmarks of the self-hosted GitHub Actions cache server: 29 MB image, 0.5 s startup, 3 MiB idle memory, 2.3 GiB/s uploads, 7.9 GiB/s downloads, 34,000 lookups per second. Method, numbers and how to run it yourself.'
---

Speed and a small footprint are why this server exists. Every change to a hot path is benchmarked against the previous image before it merges.

## Results

SQLite and filesystem storage on a Ryzen 9 5950X (32 threads), 64 GB RAM, btrfs on NVMe. `node` is the last TypeScript release (9.9.0), `rust` the Rust rewrite.

| Metric | node 9.9.0 | rust |
| --- | --- | --- |
| Image size | 260.1 MiB | 28.9 MiB |
| Startup to healthy | 3178.6 ms | 507.8 ms |
| Idle memory | 332.9 MiB | 3.0 MiB |
| Peak memory | 436.0 MiB | 88.4 MiB |
| Total CPU time | 58.56 s | 4.66 s |
| Upload (8 × 128 MiB, parallel) | 356 MiB/s | 2371 MiB/s |
| First download (merge on read) | 368 MiB/s | 8060 MiB/s |
| Later download (merged) | 829 MiB/s | 2312 MiB/s |
| Lookups per second (64 concurrent) | 1953 | 33998 |
| Lookup p50 | 27.7 ms | 1.7 ms |
| Lookup p99 | 87.7 ms | 7.0 ms |
| Small save+restore per second (256 KiB, 32 concurrent) | 4 | 1143 |

On S3 compatible storage (RustFS on the same host): 1172 MiB/s uploads, 970 MiB/s first downloads, 29,000 lookups per second and 500 small saves per second.

## Method

- Each image runs as a container on a fresh Docker volume. Cleanup jobs are off, and token validation is skipped, so the numbers measure the server and not GitHub's key endpoint.
- A protocol client sends the same requests as `@actions/cache`: Twirp calls for lookups, reservations and commits, and 32 MiB blocks for uploads.
- **Upload:** 8 entries of 128 MiB in parallel, like a build matrix.
- **First and later download:** all 8 entries, before and after the merge.
- **Lookups:** 5,000 lookups at 64 concurrent.
- **Small save+restore:** 300 entries of 256 KiB at 32 concurrent.
- CPU time comes from `cpu.stat` and memory from `memory.stat anon` (page cache excluded) in each container's cgroup, sampled every 10 ms.

The full write-up, including what each optimization changed, is in [PR #288](https://github.com/falcondev-oss/github-actions-cache-server/pull/288#issuecomment-6365513409).

## Run it yourself

The benchmark ships with the repository. It needs Docker with cgroup v2 and the systemd cgroup driver.

```bash
git clone https://github.com/falcondev-oss/github-actions-cache-server
cd github-actions-cache-server
cargo run --release --example benchmark -- \
  latest=ghcr.io/falcondev-oss/github-actions-cache-server:latest \
  node=ghcr.io/falcondev-oss/github-actions-cache-server:9.9.0
```

Pass any number of `label=image` pairs. Each image is measured in turn and the report prints one column per label.

## Compared to GitHub's hosted cache

GitHub's hosted cache is a remote service. From a self-hosted runner, every restore crosses the internet to GitHub's storage, so it is bounded by your link and your distance to GitHub. Reported numbers:

| Setup | Reported speed | 1 GiB restore |
| --- | --- | --- |
| GitHub cache, self-hosted runner | ~20 MB/s ([actuated, 2023](https://actuated.com/blog/faster-self-hosted-cache)), 5.4 MB/s from Tokyo ([google/wireit#239](https://github.com/google/wireit/issues/239), 2022) | ~54 s |
| GitHub cache, GitHub-hosted runner | 231 MB/s ([google/wireit#239](https://github.com/google/wireit/issues/239), 2022) | ~4.6 s |
| This server, over 10 GbE | the link's line rate, 1.16 GiB/s | ~0.86 s |
| This server, same host | 7.9 GiB/s (measured above) | ~0.13 s |

The GitHub figures are user reports, not a controlled benchmark, and the 10 GbE row is the link's limit, not a measurement. To measure your own case, time the same `actions/cache` restore against both backends: the step log prints the size and the speed.
