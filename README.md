# 🚀 GitHub Actions Cache Server

This repository contains the code for a self-hosted GitHub Actions cache server implementation. It allows for caching dependencies and other reusable data between GitHub Actions runs, aiming to speed up your CI/CD workflows. The cache server supports multiple storage solutions, with MinIO as a primary example.

## Features

- 🔗 **Compatible with official `actions/cache` action**
- 📦 Supports multiple storage solutions (currently only MinIO).
- 🔒 Secure and self-hosted, giving you full control over your cache data.

## Deployment

### 🐳 Using Docker

```yaml
version: "3.9"

services:
  cache-server:
    image: ghcr.io/falcondev-it/github-actions-cache-server:latest
    ports:
      - "3000:3000"
    environment:
      ACTIONS_RUNTIME_TOKEN: long_random_token
      BASE_URL: http://localhost:3000
      SECRET: long_random_secret
      MINIO_BUCKET: gh-actions-cache
      MINIO_ACCESS_KEY: access_key
      MINIO_SECRET_KEY: secret_key
      MINIO_ENDPOINT: minio
      MINIO_PORT: '9000'
      MINIO_USE_SSL: 'false'
      NITRO_PORT: '3000'
    volumes:
      - cache-data:/app/data

  minio:
    image: quay.io/minio/minio
    ports:
      - "9000:9000"
    environment:
      MINIO_ROOT_USER: access_key
      MINIO_ROOT_PASSWORD: secret_key

volumes:
  cache-data:
```

To run this server, you'll need to set up the following environment variables:

- `ACTIONS_RUNTIME_TOKEN`: A token for authenticating runtime requests. Example: `long_random_token`
- `BASE_URL`: The base URL of your cache server. Example: `http://localhost:3000`
- `SECRET`: A secret key for the server. Example: `long_random_secret`
- `MINIO_BUCKET`: The name of the MinIO bucket used for storage. Example: `gh-actions-cache`
- `MINIO_ACCESS_KEY`: The access key for MinIO. Example: `access_key`
- `MINIO_SECRET_KEY`: The secret key for MinIO. Example: `secret_key`
- `MINIO_ENDPOINT`: The endpoint URL for MinIO. Example: `minio`
- `MINIO_PORT`: The port MinIO is running on. Example: `9000`
- `MINIO_USE_SSL`: Whether to use SSL for MinIO connections. Example: `false`
- `NITRO_PORT`: The port the server should listen on. Example: `3000`

### Using with Self-Hosted Runners

To leverage the GitHub Actions Cache Server with your self-hosted runners, you'll need to configure a couple of environment variables on your runners. This ensures that your runners can authenticate with and utilize the cache server effectively.

### Configuring Environment Variables on Self-Hosted Runners

1. **`ACTIONS_RUNTIME_TOKEN`**: This environment variable is crucial for authenticating your self-hosted runner with the cache server. Set it to the same value as the `ACTIONS_RUNTIME_TOKEN` environment variable used by the server.

2. **`ACTIONS_CACHE_URL`**: This tells your self-hosted runner where to send cache requests. Set this environment variable to the `BASE_URL` of your cache server, making sure to include a trailing slash. For example, if your cache server's `BASE_URL` is `http://localhost:3000`, you would set `ACTIONS_CACHE_URL` to `http://localhost:3000/`.
