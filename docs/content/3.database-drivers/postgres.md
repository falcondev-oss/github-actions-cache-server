---
title: PostgreSQL
description:
---

Driver: `postgres`

## Configuration

#### `DB_POSTGRES_DATABASE`

The name of the PostgreSQL database to use.

#### `DB_POSTGRES_HOST`

The host of the PostgreSQL database.

#### `DB_POSTGRES_PORT`

The port of the PostgreSQL database.

#### `DB_POSTGRES_USER`

The user to authenticate with the PostgreSQL database.

#### `DB_POSTGRES_PASSWORD`

The password to authenticate with the PostgreSQL database.

#### `DB_POSTGRES_CONNECTION_STRING`

Instead of specifying the various options separately this can be used to provide
a DSN for connecting to the PostgreSQL database. For example to connect via ssl
with cert verification disabled you could provide the following:

```
DB_POSTGRES_CONNECTION_STRING=postgres://user:password@host:5432/database?sslmode=no-verify
```
