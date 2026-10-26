## Commit gate

`cargo +nightly fmt --check` and `cargo clippy --all-targets --locked` pass clean, and `cargo test` is green for every driver combo your change touches. The pre-push hook in `.githooks/` runs fmt and clippy; wire it up once per clone with `git config core.hooksPath .githooks`. Release tooling changes also need `node --test scripts/*.test.mjs`.

## Tests

Every test starts its own server on a free port. `cargo test` alone runs against SQLite and filesystem storage. For another combo, start its services with `scripts/test-services.sh <db> <storage>` (`sqlite`, `postgres`, `mysql` × `filesystem`, `s3`, `gcs`, `azblob`), then pick it with `TEST_DB_DRIVER` and `TEST_STORAGE_DRIVER`:

```sh
cargo test downloads
scripts/test-services.sh postgres s3
TEST_DB_DRIVER=postgres TEST_STORAGE_DRIVER=s3 cargo test
```

CI runs all 12 combos as a parallel matrix.

The service containers are named `gha-test-<service>` and bind fixed host ports: 5432 (postgres), 3306 (mysql), 9000 (s3), 4443 (gcs), 10000 (azblob). The script doesn't remove them; `docker rm -f` a leftover container before rerunning it. When a port is taken by another worktree, override it with `TEST_<SERVICE>_PORT` (e.g. `TEST_POSTGRES_PORT=5433`) for both the script and `cargo test`.

## External contributions

External contributions are disabled. If you are not working for a maintainer, report findings as GitHub issues instead of implementing changes or opening PRs. Each issue covers exactly one bug or feature; file separate issues for unrelated ones.

## Commands

- `cargo +nightly fmt` formats; the rules in `rustfmt.toml` need nightly rustfmt.
- `cargo clippy --all-targets` lints; `Cargo.toml` denies a strict lint set, and exceptions are `#[expect(lint, reason = "...")]`, never `#[allow]`.
- `cargo run --release --example benchmark -- label=image ...` compares server images (startup, memory, CPU, transfer speed, lookup latency); it needs Docker with cgroup v2.

## Agent skills

### Issue tracker

Issues and PRDs are tracked in GitHub Issues. See `docs/agents/issue-tracker.md`.

### Triage labels

Uses the default five triage labels. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout. See `docs/agents/domain.md`.
