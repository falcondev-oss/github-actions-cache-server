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

## Signed cache URLs (optional)

The server-proxied upload and download URLs (`/devstoreaccount1/upload/{id}` and
`/download/{id}`) are unauthenticated by default. You can enable an expiring HMAC signature
on them:

| Env var | Description |
| - | - |
| `URL_SIGNING_ENABLED` | `boolean`, default `false`. When `true`, upload/download URLs are signed on generation and strictly verified on the handlers (no unsigned fallback). |
| `URL_SIGNING_SECRET` | The active signing secret, **≥ 16 chars**. Signs every issued URL and is the first candidate on verification. Required when signing is enabled — boot fails otherwise. |
| `URL_SIGNING_SECRET_SECONDARY` | Optional verify-only rotation secret, **≥ 16 chars when set**. Never signs; accepted on verification so URLs minted with the previous secret keep working. |

Notes:

- **Stable shared value:** the secrets must be identical across all cluster workers/pods, or
  a signature minted by one worker will fail verification on another.
- **Rotation:** move the current `URL_SIGNING_SECRET` into `URL_SIGNING_SECRET_SECONDARY`,
  set the new secret as `URL_SIGNING_SECRET`, then drop `URL_SIGNING_SECRET_SECONDARY` after
  the 1h signature TTL has elapsed — no disruption.
- **Fixed 1h TTL:** signatures expire after 1 hour and cannot be refreshed mid-upload, so a
  single upload running longer than 1h will fail.
- **Enabling is a hard cutover:** flipping `URL_SIGNING_ENABLED` to `true` immediately makes
  every already-issued unsigned URL return `401`. Downloads mostly recover (buildx
  re-requests a fresh URL), but in-flight cache saves fail and re-run on the next job —
  prefer enabling during low activity.

## Documentation

👉 <https://gha-cache-server.falcondev.io/getting-started> 👈
