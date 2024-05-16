---
title: File System
description: The File System storage driver stores the cache in the local file system of the cache server. This is the default storage driver and is used when no other storage driver is specified.
---

Driver: `filesystem`

## Configuration

#### `STORAGE_FILESYSTEM_PATH`

- Default: `.data/storage/filesystem`

The path to the filesystem storage location. The folder will be created if it does not exist.
