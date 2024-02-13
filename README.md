# 🚀 GitHub Actions Cache Server

This repository contains the code for a self-hosted GitHub Actions cache server implementation. It allows for caching dependencies and other reusable data between GitHub Actions runs, aiming to speed up your CI/CD workflows. The cache server supports multiple storage solutions, with MinIO as a primary example.

## Features

- 🔥 **Compatible with official `actions/cache` action**
- 📦 Supports multiple storage solutions and is easily extendable.
- 🔒 Secure and self-hosted, giving you full control over your cache data.

## 🐳 Deployment Using Docker

```yaml
version: '3.9'

services:
  cache-server:
    image: ghcr.io/falcondev-it/github-actions-cache-server:latest
    ports:
      - '3000:3000'
    environment:
      CACHE_SERVER_TOKEN: random_token
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
      - '9000:9000'
    environment:
      MINIO_ROOT_USER: access_key
      MINIO_ROOT_PASSWORD: secret_key

volumes:
  cache-data:
```

To run this server, you'll need to set up the following environment variables:

- `CACHE_SERVER_TOKEN`: A token for authenticating runtime requests. Example: `random_token`
- `BASE_URL`: The base URL of your cache server. Example: `http://localhost:3000`
- `SECRET`: A secret key for the server. Example: `long_random_secret`
- `MINIO_BUCKET`: The name of the MinIO bucket used for storage. Example: `gh-actions-cache`
- `MINIO_ACCESS_KEY`: The access key for MinIO. Example: `access_key`
- `MINIO_SECRET_KEY`: The secret key for MinIO. Example: `secret_key`
- `MINIO_ENDPOINT`: The endpoint URL for MinIO. Example: `minio`
- `MINIO_PORT`: The port MinIO is running on. Example: `9000`
- `MINIO_USE_SSL`: Whether to use SSL for MinIO connections. Example: `false`
- `NITRO_PORT`: The port the server should listen on. Example: `3000`

## 🔥 Using with Self-Hosted Runners

To leverage the GitHub Actions Cache Server with your self-hosted runners, you'll need to configure a couple of environment variables on your runners. This ensures that your runners can authenticate with and utilize the cache server effectively.

### Configuring Environment Variables on Self-Hosted Runners

1. **`ACTIONS_CACHE_URL`**: This tells your self-hosted runner where to send cache requests. Set this environment variable to the `BASE_URL` of your cache server with the `CACHE_SERVER_TOKEN` as first path parameter, making sure to include a trailing slash. For example, if your cache server's `BASE_URL` is `http://localhost:3000` and your `CACHE_SERVER_TOKEN` is `my_token`, you would set `ACTIONS_CACHE_URL` to `http://localhost:3000/my_token/`.

### Getting the Actions Runner to Use the Cache Server

The default self-hosted runner overwrites the `ACTIONS_CACHE_URL` environment variable with the GitHub-hosted cache server URL. To get the runner to use your self-hosted cache server, you'll need to modify the runner binary in your runner Docker image:

Just add the following lines to your Dockerfile:

```Dockerfile
# modify actions runner binaries to allow custom cache server implementation
RUN sed -i 's/\x41\x00\x43\x00\x54\x00\x49\x00\x4F\x00\x4E\x00\x53\x00\x5F\x00\x43\x00\x41\x00\x43\x00\x48\x00\x45\x00\x5F\x00\x55\x00\x52\x00\x4C\x00/\x41\x00\x43\x00\x54\x00\x49\x00\x4F\x00\x4E\x00\x53\x00\x5F\x00\x43\x00\x41\x00\x43\x00\x48\x00\x45\x00\x5F\x00\x4F\x00\x52\x00\x4C\x00/g' /home/runner/bin/Runner.Worker.dll
```

This will replace the strings `ACTIONS_CACHE_URL` with `ACTIONS_CACHE_ORL` in the runner binary. This will prevent the runner from overwriting the `ACTIONS_CACHE_URL` environment variable and allow it to use your self-hosted cache server.

Doing it this way is a bit of a hack, but it's easier than compiling your own runner binary from source and works great.
