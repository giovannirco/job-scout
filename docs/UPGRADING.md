# Upgrade rehearsal and private runtime data

Develop and build from the public repository. Keep PostgreSQL/PGlite data, profiles, resumes, application history, transcripts, credentials and backups outside the public checkout and image. A new image can use the existing private database; personal settings belong in that database and credentials in an existing Kubernetes Secret/private GitOps configuration. An image update alone does not require publishing or re-entering your profile.

## Upgrading to 2.14

2.13.0 and 2.13.1 need no migration. 2.14.0 adds one, `0007_recruiter_leads`, and 2.14.1 none. The API, worker and CronJobs apply it at startup.

- **Additive migration.** `0007` creates `leads`, adds nullable `interviews.lead_id` and `outreach_events.lead_id`/`direction`/`body`, indexes, foreign keys and a position-or-lead check, and drops `NOT NULL` on `interviews.position_id`. Nothing is renamed or dropped. See [DATA-MODEL › leads](./DATA-MODEL.md#leads).
- **Rollback is image-only.** 2.13.x runs unchanged on the migrated schema, so roll back by redeploying the previous image; do not reverse the migration. Data written by the newer release (leads, rounds on a lead) stays in place and is ignored by 2.13.x.
- **Materials rule.** `materials` now means materials exist: setting that status by API or MCP fails with `materials_missing` until the position has a non-failed resume or cover, or a career-ops stamp with `pdfPath` ([MCP › Write](./MCP.md#write)). Positions already sitting in `materials` without files are listed by `pnpm db:repair-materials-status`; `--apply` moves them back to the stage they came from.
- **career-ops guard.** A career-ops sync can no longer skip or archive a role. Name the sync's API token `career-ops` or `career-ops-…` (or send `X-Job-Scout-Actor: career-ops…`) so its skip/archive requests are recorded as notes; other tokens count as a person. `create_position_from_career_ops` and `reconcile_career_ops` accept rows without a URL and never create positions for rows the tracker dropped. See [MCP › career-ops guard](./MCP.md#career-ops-skiparchive-guard).
- **Archive policy.** Triage now archives only on hard disqualifiers and respects a person's restore ([AI › Archive policy](./AI.md#archive-policy)). Older archives are not changed automatically.
- **Stale-triage sweep.** Each `watch` run re-triages up to `triage.staleSweepMaxRows` (default 20) stale active positions within half the remaining triage cap. Set `triage.staleSweepEnabled: false` to keep the old behavior.

### Repair commands

Each command prints its plan as JSON and writes nothing unless `--apply` is given. Back up the database, run the dry run, read the plan, then repeat with `--apply`. Stop other writers for large changes. Output can contain personal data; keep it private.

| command | what | flags |
|--|--|--|
| `pnpm db:repair-triage-archives` | restore triage auto-archives whose reason is not a hard disqualifier; scores are kept. Also lists (never changes) skips driven by a career-ops drop label | `--days N` (default 30), `--apply` |
| `pnpm db:retriage-timezone` | revive positions failed or archived on a timezone window alone and queue a forced triage through the worker | `--include id,id`, `--apply` |
| `pnpm db:repair-materials-status` | move positions in `materials` with no materials on file back to their earlier stage | `--apply` |
| `pnpm db:repair-last-good-jd` | restore a JD overwritten by a non-JD page from its last good revision | `--position <id>` with `--before`, `--supersede-from`, `--supersede-until`, `--supersede ev_a,ev_b`; or `--presets <file> <name>`; `--reslug`, `--live` (read-only title check), `--snapshot <get_position.json>` (plan only, no database), `--apply` |
| `pnpm db:repair-prototype-slugs` | reslug companies and postings named after an `Object.prototype` key, including their `external_identity` | `--apply` |
| `pnpm db:repair-title-slugs` | reslug positions whose slug came from an earlier or not-a-JD title | `--apply` |

The presets file for `db:repair-last-good-jd` names real positions, so keep it outside the repository: a JSON object `{ "<name>": { positionId, before?, supersedeFrom?, supersedeUntil?, supersedeEvaluations?, enqueue?, reslug?, liveCheck? } }`. Reslugging commands keep each old slug in `metadata.previousSlugs`, so links keep resolving, and write a `repair` timeline event.

`pnpm db:repair` is the separate audited runner described below: it uses `--preview`/`--apply` with a required `--report` file instead of the dry-run default.

## Existing installations

Normal API/worker startup now runs schema migrations and initializes missing profile/settings rows. It does not run legacy data repairs or fetch job boards on an existing installation. Fresh installations still seed the generic source catalog. Do not run the old and new application versions against the same database during rehearsal.

1. Take a database backup and restore it into an isolated database. Stop API, worker, CronJobs and other writers for that copy. Use the target public checkout with the copy's DATABASE_URL (or a copied PGLITE_DATA_DIR), never production credentials. Disable external notification/model/browser integrations in the rehearsal environment.
2. Run `pnpm install --frozen-lockfile` and `pnpm db:migrate` against the restored copy.
3. Run `pnpm db:repair --preview --report /private/path/preview.json`.
4. Inspect every step's result and changes: table, row ID, operation, and changed fields before/after. Fetch failures include `failedIds`. A failed report exits nonzero and all database changes roll back. Fix source access or data problems and repeat using a new report filename.
5. When the preview is acceptable, run `pnpm db:repair --apply --report /private/path/applied.json` against the restored copy. Compare the report and smoke-test the app. Repeat apply with another filename: completed versioned steps must be skipped. Start twice and compare profile/posting states.
6. After a successful rehearsal, take another backup and perform the same explicit migration/preview/apply procedure during the real maintenance window. Keep API/workers stopped until it completes.

Preview runs the actual repair helpers in one transaction, captures per-step row differences, and rolls back. Apply commits data and repair-version markers together only when every step succeeds. `ok` means that step executed; only an overall `applied` outcome means changes persisted. Following a failure, later steps remain `pending`. PostgreSQL uses a transaction advisory lock to serialize repair runners; it does not stop ordinary application writes, so stopping other writers is required. PGlite also uses transaction-scoped database access.

Reports are created exclusively with mode 0600, never overwrite existing files, and may contain personal data. Keep reports and CLI logs private and out of issues/PRs. The report can be large because it records actual row changes. The runner snapshots tables between steps and favors auditability over speed; allow enough memory/time for a large restored database.

Some repairs read live ATS pages. Preview rolls back database writes and queued work, but cannot undo network reads or freeze the employer's response between preview and apply. It does not run model calls or dispatch queued notifications itself. Apply is atomic across the selected steps; restoring a backup is the rollback path after a successful commit. Existing legacy markers are intentionally superseded by independent repairVersions so partially completed older repairs are not silently accepted.

The destructive identical-JD merge/archive repair was removed. Distinct ATS identities remain distinct postings, while queue grouping can still combine related links for display. Already lost identity/link history cannot be reconstructed from identical text; compare a pre-upgrade backup and re-ingest the original URLs after review.

The companion security change documents authentication, certificate verification and browser isolation in SECURITY.md. Supply runtime secrets through the chart's existingSecret; do not put real values in public Helm values.

## Selecting independent repairs

`pnpm db:repair --list` prints the available names without running them. Use `--steps titles,entities,salary-object` with either `--preview` or `--apply` to review a bounded subset. Selected steps retain their canonical order; unknown or empty names are rejected before database writes. Only selected steps receive completion markers, and all selected steps still commit or roll back together. Use identical selections for preview and apply. This lets local corrections proceed independently when a remote ATS record is unavailable; inspect dependencies and the report before selecting a subset.

## Prototype-key slugs

Older builds looked company aliases up in a plain object, so a company named after an `Object.prototype` key (for example "Constructor") received a slug such as `function Object() { [native code] }`, and its postings inherited it. New rows are fixed. `pnpm db:repair-prototype-slugs` prints the affected companies and postings without writing; add `--apply` to reslug them. Each replaced slug is kept in `metadata.previousSlugs`, which position and company lookups still resolve, and every reslugged posting gets a `repair` timeline event. Back up the database first.

## JD refresh at interview and offer

From the interview stage on, the job description you interviewed for is the record. A board scan, watch check or plain `refresh_jd` is now refused with `frozen:interview` or `frozen:offer` and writes no revision; a closed listing still closes. An automatic watch also no longer rewrites a position outside the active stages whose `watchEnabled` is false (`watch_disabled`). To refresh such a description deliberately, call `refresh_jd` with `force: true` or `POST /positions/:id/refresh` with `{"force": true}`. Forcing never bypasses the not-a-JD, failed-fetch or identity guards. Because Jev checks follow JD revisions, an interview- or offer-stage position gets a new check only after a forced refresh.

Posting URLs that differ only by a redundant `gh_jid` or `ashby_jid` parameter now count as the same posting, so re-ingesting one no longer creates a duplicate. Duplicates created earlier are left as they are; archive the extra copy after review. For `pnpm db:repair-last-good-jd`, `--reslug` renames a slug that was built from a not-a-JD title and keeps the old slug resolvable, and `--live` compares the live posting's title with the restored one without writing anything.
