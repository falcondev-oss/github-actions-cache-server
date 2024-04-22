# 🚀 GitHub Actions Cache Server

This repository contains the code for a self-hosted GitHub Actions cache server implementation. It allows for caching dependencies and other reusable data between GitHub Actions runs, aiming to speed up your CI/CD workflows. The cache server supports multiple storage solutions, with MinIO as a primary example.

## Features

- 🔥 **Compatible with official `actions/cache` action**
- 📦 Supports multiple storage solutions and is easily extendable.
- 🔒 Secure and self-hosted, giving you full control over your cache data.
- 😎 Easy setup

```yaml
version: '3.9'

services:
  cache-server:
    image: ghcr.io/falcondev-oss/github-actions-cache-server
    ports:
      - '3000:3000'
    environment:
      URL_ACCESS_TOKEN: random_token
      API_BASE_URL: http://localhost:3000
    volumes:
      - cache-data:/data

volumes:
  cache-data:
```

## Documentation

👉 <https://gha-cache-server.falcondev.io/getting-started> 👈
