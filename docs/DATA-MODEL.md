# Data model

Schema: `packages/db/src/schema.ts` (drizzle). Migrations: `packages/db/migrations/` (`pnpm db:generate` after editing the schema; the API applies them on boot). Postgres in production, PGlite when `DATABASE_URL` is unset.

## Enums

| enum | values |
|--|--|
| **PositionStatus** | `triaged` → `review` → `materials` → `applied` → `screen` → `interview` → `offer` · terminal: `rejected`, `skip`, `archived` |
| **HOT_STATUSES** | `review materials applied screen interview offer` — "in play"; used by Companies counts, JD-review policy, Today |
| **TriageVerdict** | `pass` · `marginal` · `fail` |
| **EvaluationKind** | `evaluate` · `jd_review` · `company_research` |
| **ListingStatus** | `open` · `changed` · `closed` · `paused` |
| **DiscoveryLane** | `passed` · `marginal` · `filtered` |
| **JobType** | `board_scan` `watch_check` `scan_url` `triage` `evaluate` `materials` `company_research` `jd_review` `listing_classify` `form_answers` `interview_brief` `retention` |
| **LlmOperation** | `triage` `evaluate` `materials` `company_research` `jd_review` `chat` `listing_classify` `form_answers` `interview_brief` (+ `test`) |
| **ApprovalKind / Status** | `status_suggestion` `materials_draft` `archive_suggestion` / `pending` `approved` `dismissed` `expired` |
| **ChatScope** | `global` · `position` · `company` |

## Tables

### Pipeline

| table | what |
|--|--|
| `companies` | slug, name, website, careers URL, industry tags, metadata (aliases, ATS tokens) |
| `positions` | the CRM row — see below |
| `jd_revisions` | append-only JD history per position: `revision`, `observed_at`, `content_hash`, `change_kind` (`first_seen` `content` `title` `comp` `geo` `status` `closed` `reopened` `noise_rebase` `manual`), `material`, full JD fields, `field_diffs`, `diff_summary`. One `closed` revision per closing; later checks only bump `positions.last_checked_at` |
| `timeline_events` | notes, status changes, applied, LLM results, approvals — everything History shows |
| `evaluations` | one row per LLM report: `kind`, `model`, `markdown`, `summary` JSON, score/verdict; `position_id` or `company_id` |
| `application_materials` | `kind` resume / cover, `version`, markdown, surface + keyword coverage in metadata |
| `application_questions` | Q&A drafts for application forms |
| `people`, `interviews`, `outreach_events` | contacts; interview rounds (stage, interviewer, outcome, transcript, same-day review, AI brief vs JD/company pack); outreach log |

### Radar

| table | what |
|--|--|
| `board_sources` | one row per board: provider (greenhouse / ashby / lever / remoteok / market / html), token/URL, enabled, capability (`list_api` is scanned: ATS + RemoteOK JSON + WWR DevOps RSS), last scan |
| `board_snapshots` | listings seen per scan (retention keeps the last 3 per board) |
| `board_deltas` | new / changed / closed listings between snapshots |
| `discovery_feed` | every listing observed in the window, with `lane` (`passed` / `filtered`) and `gate_reason`. Archiving a filing for the gate moves its row to `filtered` |
| `watches` | standalone URL watches not tied to a board |

### Machine

| table | what |
|--|--|
| `jobs` | the queue: `type`, `payload`, `status` (queued/running/succeeded/failed), `priority`, `dedupe_key`, `attempts`, `run_after`, `started_at`, `error`, `result` |
| `llm_runs` | one row per model call: operation, model, tokens in/out, latency, ok/error, position/company |
| `settings` | single JSON document (see `packages/shared/src/settings.ts`): `llm.operations`, `gate`, `triage`, `scan`, `retention`, `autopilot`, `chat`, `notifications` (WhatsApp channels/events/quiet hours/allowFrom), cached model catalog |
| `approvals` | autopilot inbox: `kind`, `status`, position/company, title/body, `payload` (e.g. `toStatus`, `materialIds`, `reason`), resolved by/at |
| `chat_threads` | `scope`, position/company, model, `messages` JSON (user / assistant with tool calls / tool results, tokens). WhatsApp desk chat uses one global thread titled `WhatsApp · job-scout chat` |
| `notification_outbox` | WhatsApp sends: `channel`, `event`, `chat_id`, `body`, `status` (`pending` `sent` `failed` `cancelled`), unique `dedupe_key`, `scheduled_for` (quiet hours), `provider_ref` |
| `profiles` | you: identity, master resume, resume surfaces (`ai` / `sre` / `platform`), scout brief |
| `api_tokens` | hashed Bearer tokens with scopes |

## `positions`

| group | columns |
|--|--|
| identity | `id`, `company_id`, `slug` (unique), `title`, `primary_url`, `ats_provider`, `ats_job_id`, `ats_board_token`, `external_identity` (`provider:token:jobId`), `source` |
| pipeline | `status`, `priority`, `applied_at`, `next_action`, `notes`, `resume_surface`, `archive_reason` |
| classification | `craft_family`, `geo_class`, `remote_class`, `geo_notes`, `employment_type` |
| triage | `triage_score` (1–5), `triage_verdict`, `triage_json`, `triaged_at`, `triage_model` |
| comp | `salary_min/max/currency/period/raw`, `equity_notes` |
| listing | `content_hash`, `listing_status`, `first_seen_at`, `last_checked_at`, `last_changed_at`, `closed_at`, `watch_enabled` |
| links | `metadata` JSON — `careerOps { trackerId, score, status, reportPath, pdfPath, jdPath, stampedAt }` when the row is mirrored in career-ops |

Evaluations, materials and JD text are not on the row; they hang off it by `position_id`, and the list endpoints return a slim projection (`PositionListRow` in `packages/shared/src/types.ts`).

## Retention

`Settings › System` / `RetentionConfig`: `snapshotsKeep` 3 per board · `jobsDays` 7 · `discoveryDays` 30 · `deltasDays` 30 · `llmRunsDays` 90. Positions, revisions, evaluations, materials and timeline are never pruned.
