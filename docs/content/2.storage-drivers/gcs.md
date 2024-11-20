---
title: Google Cloud Storage
description: This storage driver stores the cache in a GCS bucket.
---

Driver: `gcs`

This storage driver stores the cache in a GCS bucket.

::u-alert
---
icon: 'tabler:alert-triangle'
class: ring-amber-400
color: amber
description: Because GCS doesn't support out-of-order multipart uploads (as of November 2024), the cache server will upload the parts into a temporary folder. To combine the parts into a single object, it will download all the parts and re-upload the combined object. This means using GCS as your storage driver will use 3x the bandwidth compared to other storage drivers.
variant: subtle
---
::

## Configuration

### `docker-compose` GCS bucket

```yaml [docker-compose.yml]
version: '3.9'

services:
  cache-server:
    image: ghcr.io/falcondev-oss/github-actions-cache-server:latest
    ports:
      - '3000:3000'
    environment:
      URL_ACCESS_TOKEN: random_token
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
