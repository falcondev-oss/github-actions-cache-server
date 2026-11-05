---
title: Database drivers
description: 'Database backends for the cache metadata of the self-hosted GitHub Actions cache server: SQLite, PostgreSQL and MySQL.'
sidebar:
  label: Overview
---

The database holds cache keys, versions and upload state, never payloads. Pick it with [`DB_DRIVER`](/configuration#db_driver).

| Driver | `DB_DRIVER` | Replicas | Best for |
| --- | --- | --- | --- |
| [SQLite](/database-drivers/sqlite) | `sqlite` (default) | One | One host, no extra service |
| [PostgreSQL](/database-drivers/postgres) | `postgres` | Many | Production, several replicas |
| [MySQL](/database-drivers/mysql) | `mysql` | Many | Production, several replicas |

The server runs its migrations on startup.
