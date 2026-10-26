## Commit gate

`pnpm lint` and `pnpm type-check` pass clean, and `pnpm test:run` is green for every driver combo your change touches. The pre-push hook in `.githooks/` runs lint and type-check; `pnpm install` wires it up. `pnpm lint:fix` applies ESLint and Prettier fixes. Prettier also checks Markdown, YAML and JSON, so run the gate after docs-only edits too.

## Tests

`tests/setup.ts` builds the server, serves it on port 3000 and starts the database and storage containers through testcontainers. Pick the combo with `VITEST_DB_DRIVER` (`sqlite` default, `postgres`, `mysql`) and `VITEST_STORAGE_DRIVER` (`filesystem` default, `s3`, `gcs`, `azblob`), and pass test files as arguments:

```sh
pnpm test:run tests/range-download.test.ts
VITEST_DB_DRIVER=postgres VITEST_STORAGE_DRIVER=s3 pnpm test:run tests/s3-storage.test.ts
```

`pnpm test:matrix` runs all 12 combos in sequence; CI runs them as a parallel matrix.

The server and containers bind fixed host ports: 3000 (server), 5432 (postgres), 3306 (mysql), 9000 (s3, gcs), 10000 (azblob). Run one test run per machine at a time: stop `pnpm dev` and test runs in other worktrees first, and confirm the ports are free with `ss -ltn`. `EADDRINUSE` or a container port-bind error means a collision, so free the port and rerun.

## External contributions

External contributions are disabled. If you are not working for a maintainer, report findings as GitHub issues instead of implementing changes or opening PRs. Each issue covers exactly one bug or feature; file separate issues for unrelated ones.

## Agent skills

### Issue tracker

Issues and PRDs are tracked in GitHub Issues. See `docs/agents/issue-tracker.md`.

### Triage labels

Uses the default five triage labels. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout. See `docs/agents/domain.md`.
