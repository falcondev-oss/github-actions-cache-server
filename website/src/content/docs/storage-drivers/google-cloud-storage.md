---
title: Google Cloud Storage
description: 'Store self-hosted GitHub Actions caches in a Google Cloud Storage bucket, with optional direct downloads from the bucket.'
---

Driver: `gcs`

This storage driver stores the cache in a GCS bucket.

## Configuration

### `docker-compose` GCS bucket

```yaml title="docker-compose.yml"
services:
  cache-server:
    image: ghcr.io/falcondev-oss/github-actions-cache-server:latest
    ports:
      - '3000:3000'
    environment:
      API_BASE_URL: http://localhost:3000

      STORAGE_DRIVER: gcs
      STORAGE_GCS_BUCKET: gh-actions-cache
      # Optional, not required if running on GCP
      STORAGE_GCS_SERVICE_ACCOUNT_KEY: /gcp/config/application_default_credentials.json
    volumes:
      - cache-data:/app/.data

      # Use host's application default credentials
      - $HOME/.config/gcloud:/gcp/config:ro

volumes:
  cache-data:
```

### Environment Variables

Don't forget to set the `STORAGE_DRIVER` environment variable to `gcs` to use the GCS storage driver.

#### `STORAGE_GCS_BUCKET`

Example: `gh-actions-cache`

The name of the GCS bucket used for storage.

#### `STORAGE_GCS_SERVICE_ACCOUNT_KEY`

Example: `/config/auth/serviceaccount.json`

Path to the service account key used for authentication. If not set, [Application Default Credentials](https://cloud.google.com/docs/authentication/application-default-credentials) is used.

#### `STORAGE_GCS_ENDPOINT`

Example: `http://localhost:9000`

The API endpoint for GCS.

## Minimal permissions

All cache objects live under the `gh-actions-cache/` prefix in the bucket. The service account needs these IAM permissions on the bucket:

| Permission               | Used for                                    |
| ------------------------ | ------------------------------------------- |
| `storage.buckets.get`    | Startup bucket check                        |
| `storage.objects.get`    | Downloading cache entries, existence checks |
| `storage.objects.list`   | Listing/counting cache objects              |
| `storage.objects.create` | Uploading cache entries, merging parts      |
| `storage.objects.delete` | Cache cleanup and abandoned uploads         |

The predefined [`roles/storage.objectAdmin`](https://cloud.google.com/storage/docs/access-control/iam-roles) role covers all the object permissions but **not** `storage.buckets.get`. Either grant `roles/storage.objectAdmin` together with `roles/storage.legacyBucketReader`, or create a custom role with the five permissions above.

Parts are uploaded through signed URLs, and direct downloads (`ENABLE_DIRECT_DOWNLOADS`) hand out signed URLs too. Without a `STORAGE_GCS_SERVICE_ACCOUNT_KEY` (i.e. using Application Default Credentials), signing requires the `iam.serviceAccounts.signBlob` permission (granted by `roles/iam.serviceAccountTokenCreator`). Without it, uploads fall back to multipart and direct downloads fail. This is not needed when a service account key file is provided, since URLs are then signed locally.
