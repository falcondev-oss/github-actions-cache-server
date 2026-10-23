## Commands

- `cargo +nightly fmt` formats; the rules in `rustfmt.toml` need nightly rustfmt.
- `cargo clippy --all-targets` lints; `Cargo.toml` denies a strict lint set, and exceptions are `#[expect(lint, reason = "...")]`, never `#[allow]`.
- `cargo test` runs against SQLite and filesystem storage. `scripts/test-services.sh <db> <storage>` starts the other backends in Docker; then run `TEST_DB_DRIVER=<db> TEST_STORAGE_DRIVER=<storage> cargo test`.
- `node --test scripts/*.test.mjs` tests the release tooling.

## Agent skills

### Issue tracker

Issues and PRDs are tracked in GitHub Issues. See `docs/agents/issue-tracker.md`.

### Triage labels

Uses the default five triage labels. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout. See `docs/agents/domain.md`.
