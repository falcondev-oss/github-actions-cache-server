---
title: SQLite
description:
---

Driver: `sqlite`

::u-alert
---
icon: 'tabler:alert-triangle'
class: ring-amber-400
color: amber
description: It is recommended to use a more robust database driver for production use.
variant: subtle
---
::

## Configuration

#### `DB_SQLITE_PATH`

- Default: `.data/sqlite.db`

The path to the SQLite database file. This file will be created if it does not exist.
