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
    image: ghcr.io/falcondev-oss/github-actions-cache-server
    ports:
      - '3000:3000'
    environment:
      API_BASE_URL: http://localhost:3000
      STORAGE_DRIVER: filesystem
      STORAGE_FILESYSTEM_PATH: /data/cache
      DB_DRIVER: sqlite
      DB_SQLITE_PATH: /data/cache-server.db
    volumes:
      - cache-data:/data

volumes:
  cache-data:
```

## Resource limits

All optional.

| Variable                   | Default  | Effect                                                                                                            |
| -------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------- |
| `MAX_CONCURRENT_MERGES`    | `16`     | Merges one process runs at once, eager or lazy. Beyond it, restores stream the parts and a later download merges. |
| `DOWNLOAD_IDLE_TIMEOUT_MS` | `300000` | Closes a connection whose client has not read a response for this long; `0` disables.                             |

## Documentation

👉 <https://gha-cache-server.falcondev.io/getting-started> 👈
