# 2.14.2

Maintenance release: safer startup, documentation that matches the code, and test fixtures that are fully synthetic. No database migration.

- **Migrations are serialized.** The api, worker and every CronJob run migrations at startup; on Postgres they now hold an advisory lock on a single connection, so a release with a migration can roll out in any order without racing.
- **Version reporting.** An image built without `APP_VERSION` reports the `package.json` version instead of 2.0.0 (health, `server_info`, build-info metric).
- **REST `board_index`.** `POST /positions` with a careers-index URL now returns `details.code: "board_index"`, as MCP already did.
- **Smaller fixes.** The `job_scout_watch_checks_total` help text lists the outcomes actually emitted. The `run_llm` and `list_all_interviews` descriptions are accurate. CI runs `pnpm lint:strict`.
- **Docs.**
  - Every MCP tool and REST route is documented.
  - New "JD snapshots" section in ARCHITECTURE, and an archive-policy section in AI.
  - DATA-MODEL covers leads and metadata keys.
  - An "Upgrading to 2.14" guide with every repair command.
  - A generic `docs/DEPLOY.md`.
- **Fixtures.** Test data and one UI placeholder that had been copied from real use are replaced with fictional values.
