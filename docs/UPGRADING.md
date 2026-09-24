# Upgrade rehearsal and private runtime data

Develop and build from the public repository. Keep PostgreSQL/PGlite data, profiles, resumes, application history, transcripts, credentials and backups outside the public checkout and image. A new image can use the existing private database; personal settings belong in that database and credentials in an existing Kubernetes Secret/private GitOps configuration. An image update alone does not require publishing or re-entering your profile.

## Existing installations

Normal API/worker startup now runs schema migrations and initializes missing profile/settings rows. It does not run legacy data repairs or fetch job boards on an existing installation. Fresh installations still seed the generic source catalog. Do not run the old and new application versions against the same database during rehearsal.

1. Take a database backup and restore it into an isolated database. Stop API, worker, CronJobs and other writers for that copy. Use the target public checkout with the copy's DATABASE_URL (or a copied PGLITE_DATA_DIR), never production credentials. Disable external notification/model/browser integrations in the rehearsal environment.
2. Run `pnpm install --frozen-lockfile` and `pnpm db:migrate` against the restored copy.
3. Run `pnpm db:repair --preview --report /private/path/preview.json`.
4. Inspect every step's result and changes: table, row ID, operation, and changed fields before/after. Fetch failures include `failedIds`. A failed report exits nonzero and all database changes roll back. Fix source access or data problems and repeat using a new report filename.
5. When the preview is acceptable, run `pnpm db:repair --apply --report /private/path/applied.json` against the restored copy. Compare the report and smoke-test the app. Repeat apply with another filename: completed versioned steps must be skipped. Start twice and compare profile/posting states.
6. After a successful rehearsal, take another backup and perform the same explicit migration/preview/apply procedure during the real maintenance window. Keep API/workers stopped until it completes. No live deployment is performed by this change.

Preview runs the actual repair helpers in one transaction, captures per-step row differences, and rolls back. Apply commits data and repair-version markers together only when every step succeeds. `ok` means that step executed; only an overall `applied` outcome means changes persisted. Following a failure, later steps remain `pending`. PostgreSQL uses a transaction advisory lock to serialize repair runners; it does not stop ordinary application writes, so stopping other writers is required. PGlite also uses transaction-scoped database access.

Reports are created exclusively with mode 0600, never overwrite existing files, and may contain personal data. Keep reports and CLI logs private and out of issues/PRs. The report can be large because it records actual row changes. The runner snapshots tables between steps and favors auditability over speed; allow enough memory/time for a large restored database.

Some repairs read live ATS pages. Preview rolls back database writes and queued work, but cannot undo network reads or freeze the employer's response between preview and apply. It does not run model calls or dispatch queued notifications itself. Apply is atomic, not selective; restoring a backup is the rollback path after a successful commit. Existing legacy markers are intentionally superseded by independent repairVersions so partially completed older repairs are not silently accepted.

The destructive identical-JD merge/archive repair was removed. Distinct ATS identities remain distinct postings, while queue grouping can still combine related links for display. Already lost identity/link history cannot be reconstructed from identical text; compare a pre-upgrade backup and re-ingest the original URLs after review.

The companion security change documents authentication, certificate verification and browser isolation in SECURITY.md. Supply runtime secrets through the chart's existingSecret; do not put real values in public Helm values.
