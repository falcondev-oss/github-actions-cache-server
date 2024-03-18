---
title: MinIO
description:
---

Driver: `memory`

The memory storage driver stores the cache in memory. This is useful for testing and development purposes but should not be used in production.

## Configuration

### `docker-compose` example

```yaml [docker-compose.yml]
version: '3.9'

services:
  cache-server:
    image: ghcr.io/falcondev-oss/github-actions-cache-server:latest
    ports:
      - '3000:3000'
    environment:
      CACHE_SERVER_TOKEN: random_token
      BASE_URL: http://localhost:3000

      STORAGE_DRIVER: minio
      MINIO_BUCKET: gh-actions-cache
      MINIO_ACCESS_KEY: access_key
      MINIO_SECRET_KEY: secret_key
      MINIO_ENDPOINT: minio
      MINIO_PORT: '9000'
      MINIO_USE_SSL: 'false'
    volumes:
      - cache-data:/app/data

  minio:
    image: quay.io/minio/minio
    ports:
      - '9000:9000'
    environment:
      MINIO_ROOT_USER: access_key
      MINIO_ROOT_PASSWORD: secret_key

volumes:
  cache-data:
```

### Environment Variables

Don't forget to set the `STORAGE_DRIVER` environment variable to `minio` to use the MinIO storage driver.

#### `MINIO_BUCKET`

Example: `gh-actions-cache`

The name of the MinIO bucket used for storage.

#### `MINIO_ACCESS_KEY`

Example: `access_key`

The access key for MinIO.

#### `MINIO_SECRET_KEY`

Example: `secret_key`

The secret key for MinIO.

#### `MINIO_ENDPOINT`

Example: `minio`

The endpoint hostname for MinIO.

#### `MINIO_PORT`

Example: `9000`

The port MinIO is running on.

#### `MINIO_USE_SSL`

- Default: `false`

Whether to use SSL for MinIO connections.
