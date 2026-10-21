# 2.14.0

Closes the follow-ups found while verifying 2.13 in production, adds recruiter leads, and retires the lint backlog. One additive database migration (`0007_recruiter_leads`); 2.13.x runs unchanged on the migrated schema, so rollback is still image-only.

**Recruiter leads (#13).**
- New `leads` entity for recruiter messages with no job description: recruiter, pitched role, client hint, stated terms, open unknowns, thread URLs, and a status pipeline (`new → vetted → replied → screening_scheduled → screened → promoted/closed`).
- MCP: `upsert_lead`, `list_leads`, `get_lead`, `log_lead_message`, `promote_lead`, `link_lead_position`, `merge_leads`; REST under `/api/v1/leads`.
- Two threads from the same recruiter for the same role collapse into one lead. Phone numbers and emails are redacted from stored message bodies and logged tool arguments.
- A deterministic lead triage compares pay with the cash floor only for explicit USD yearly figures and never invents one.
- Interviews can belong to a lead (`upsert_interview` with `leadId`), show in upcoming interviews and Today, and move to the position when the lead is promoted. `work_queue` has a `leads` lane.
- Tracking only: nothing is ever sent.

**LLM health (#18).** After an outage, a successful call on any operation clears `providerDown` and releases parked jobs right away, instead of waiting for the failing operation's own probe.

**Change detection (#19).** A JD whose only difference is decoded HTML entities is cosmetic: no material revision, no paid review.

**Stale triage sweep (#20).** The watch run re-triages up to `triage.staleSweepMaxRows` (default 20) stale active positions per run, oldest first, using at most half of the remaining daily triage cap and never while the provider is down. Archived, closed, quarantined and hot positions are skipped. Unbacked `changed` badges are cleared.

**Career-ops rows without a URL (#21).**
- `create_position_from_career_ops` accepts rows with no URL, matched by tracker id, then URL, then exact company + title. Re-runs link the same position.
- A URL that arrives later is set on that position.
- `reconcile_career_ops` creates manual positions for unmatched URL-less rows on a real run, except rows the tracker dropped (Discarded/SKIP/Withdrawn, reported as `skippedDropped`).

**Lint (#12).** `pnpm lint:strict` passes with zero warnings, and `no-unnecessary-condition` and `no-misused-promises` are errors. Desk actions whose failures were only visible in the browser console now show an error toast.
