---
title: Storage drivers
description: 'Storage backends for the self-hosted GitHub Actions cache server: local filesystem, S3 (AWS, RustFS, MinIO, Cloudflare R2), Google Cloud Storage and Azure Blob Storage.'
sidebar:
  label: Overview
---

The storage driver holds the cache payloads. Pick it with [`STORAGE_DRIVER`](/configuration#storage_driver).

| Driver | `STORAGE_DRIVER` | Direct downloads | Best for |
| --- | --- | --- | --- |
| [File system](/storage-drivers/file-system) | `filesystem` (default) | No | One host with local NVMe, the fastest setup |
| [S3, RustFS, MinIO, R2](/storage-drivers/s3) | `s3` | Yes | Several replicas, any S3 compatible store |
| [Google Cloud Storage](/storage-drivers/google-cloud-storage) | `gcs` | Yes | Runners on GCP |
| [Azure Blob Storage](/storage-drivers/azure-blob-storage) | `azblob` | Yes | Runners on Azure |

## Object storage

On S3, GCS and Azure Blob Storage, parts are uploaded through presigned URLs, so the credentials must be able to sign. Without that, uploads fall back to multipart.

The server trusts an object it has seen to exist for a minute instead of checking storage on every cache hit. Data deleted behind the server's back (another replica, a bucket lifecycle rule) can still be promised to a runner for up to a minute.
