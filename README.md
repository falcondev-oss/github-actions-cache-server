# 🚀 GitHub Actions Cache Server

This is a drop-in replacement for the official GitHub hosted cache server. It is compatible with the official `actions/cache` action, so there is no need to change your workflow files and it even works with packages that internally use `actions/cache`.

## Features

- 🔥 **Compatible with official `actions/cache` action**
- 📦 Supports multiple storage solutions and is easily extendable.
- 🔒 Secure and self-hosted, giving you full control over your cache data.
- 😎 Easy setup

```yaml
services:
  cache-server:
    image: ghcr.io/falcondev-oss/github-actions-cache-server:latest
    ports:
      - '3000:3000'
      - '8000:8000'
    environment:
      API_BASE_URL: http://localhost:3000
      CA_KEY_PATH: /run/secrets/ca_key
      CA_CERT_PATH: /run/secrets/ca_cert
    volumes:
      - cache-data:/app/.data
    secrets:
      - ca_key
      - ca_cert

volumes:
  cache-data:

secrets:
  ca_key:
    file: ./key.pem
  ca_cert:
    file: ./cert.pem
```

## Documentation

👉 <https://gha-cache-server.falcondev.io/getting-started> 👈
