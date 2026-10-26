# The server is a single Rust binary

The server was rewritten from Nitro/Node.js to one statically linked Rust binary (axum on tokio). The wire protocols, environment variables, database schema and storage layout are unchanged, so an existing deployment upgrades by swapping the image.

The schema and its Kysely bookkeeping tables (`kysely_migration`, `kysely_migration_lock`) are kept as they are, migrations take the same Postgres advisory lock and MySQL named lock Kysely used, and fresh databases record the same migration names. A database written by either implementation stays readable by the other.

Database access goes through SeaORM entities on native sqlx pools, so one code path renders correctly quoted SQL for Postgres, MySQL and SQLite. SQLite has one writer connection, as with `better-sqlite3`, and runs in WAL mode so a pool of read-only connections serves lookups beside it. S3, Google Cloud Storage and Azure Blob Storage share one adapter on the `object_store` crate; the filesystem adapter is separate because it needs `statvfs` for the Storage Budget.

Superseded parts of earlier decisions:

- ADR-0007: there are no cluster workers any more. One process serves all requests on a multi-threaded runtime, so its metrics are already process-wide; scaling is still by replicas.
- ADR-0009: Server-side Merge is gone. `object_store` has no `UploadPartCopy`, GCS `compose` or Azure `Put Block From URL`, and one adapter for all object stores was worth more than the optimization. On object storage, Eager Merge always streams the Parts through the server; on the filesystem, a Merge is a kernel copy (`copy_file_range`).

Dropped with Node.js: the `-caged` image variant (V8 pointer compression), the `BENCHMARK` heap logging, and the oRPC `/management-api/_rpc` endpoint with the TypeScript SDK, which typed itself from the server source. The REST management API and its OpenAPI document remain.
