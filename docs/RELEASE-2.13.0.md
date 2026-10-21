# 2.13.0

Fixes from a month of real use: job descriptions that were overwritten or missing, archives nobody asked for, agents that couldn't page or correct data, and model outages nobody noticed. No database migration is required.

**Job descriptions are kept safe.**
- A JS wall, loading placeholder, vendor boilerplate, soft-404 page or another company's posting no longer replaces a stored JD. A text-only "not found" page closes a listing only on a second observation.
- The JD is frozen at interview and offer unless a refresh is forced.
- New fetchers: InHire, Recruitee, Workable. Ashby liveness and pay come from its posting API.
- A JD too short to score is stored with `needsJd`; triage, evaluation and research wait for the real one, then re-run.
- Retitles on the board are followed and the slug moves with them (old slugs keep resolving).
- Fetch failures say why (`http_status`, `blocked`, `timeout`, `network`, `parse_failed`, `unsupported_provider`).
- Cosmetic churn and location strings that only gain detail no longer count as material changes, and a JD review runs at most once a day for description edits.

**Archive only on hard disqualifiers.**
- Triage archives a fail only for residency, work authorization, onsite/hybrid or posted pay under a set floor. Skill gaps, low scores and timezone windows never archive. A person's restore is respected.
- A timezone window alone never disqualifies a role; an optional profile range makes it a soft flag.
- Location reads structured data first (JSON-LD, ATS workplace type), and multi-country and region-remote postings stay that way.
- The career-ops sync can't skip or archive on its own.
- `materials` requires drafts or a stamped PDF.

**MCP for agents.**
- `list_positions` and `list_changes` page with opaque cursors and stay under the result cap. Rows are lean by default; `fields: "full"` restores the rest.
- Write tools return a compact summary (`verbose: true` for the full record).
- `update_position` corrects title, URL, workplace and geo. Manual workplace and geo are kept by later classification.
- `upsert_interview` accepts `scheduled`.
- Writes are attributed to `<caller> via <token>` through `X-Job-Scout-Actor`/`X-Agent-Name` or an `actor` argument.
- New `screen_recruiter_threat` rates recruiter outreach for fake-interview lures (based on a contribution by @RonaldCrb).

**Operations.**
- Model outages are detected from recent runs. LLM jobs are parked instead of failing, one alert goes out on failure and one on recovery, and the state shows in `/api/v1/health` (`llm`), `server_info` and Prometheus.
- Background sweeps, repairs and reclassification leave timeline entries.
- Aggregator reposts resolve to the real employer.

**Repairs (dry run by default, `--apply` to write).** `db:repair-triage-archives`, `db:repair-last-good-jd`, `db:repair-materials-status`, `db:repair-prototype-slugs`, `db:repair-title-slugs`, `db:retriage-timezone`.
