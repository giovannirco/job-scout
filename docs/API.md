# API

Base `/api/v1`. Every response is an envelope:

```json
{ "ok": true,  "data": …, "meta": { "requestId": "…", "page": 1, "pageSize": 50, "total": 60 } }
{ "ok": false, "error": { "code": "NOT_FOUND", "message": "…", "details": {} }, "meta": { "requestId": "…" } }
```

Codes: `UNAUTHORIZED` `NOT_FOUND` `VALIDATION_ERROR` `LLM_GATE` `INTERNAL`. Long-running actions return `202` with a `jobId`. `LLM_GATE` is a model call refused before it runs (no key, disabled, cap, or budget).

## Auth

```bash
curl -H "Authorization: Bearer dev-agent-token" http://localhost:8080/api/v1/today
```

A configured `API_TOKEN_SEED` is an admin credential; there is no built-in seed. Only admins can manage tokens under `/settings/tokens`. The UI uses a session cookie from `POST /auth/login {password}`. `AUTH_MODE=dev` needs neither.

## Routes

### Today

| method | path | notes |
|--|--|--|
| GET | `/today` | decisions, follow-ups, changed, upcoming interviews, counts by status + last30d + appliedThisWeek, queue, LLM usage, pending approvals, recent activity |
| GET | `/today/changes?since=&limit=` | positions/evaluations changed after an ISO time (default 24 h) |

### Process / Interviews desk

| method | path | notes |
|--|--|--|
| GET | `/interviews` | all rounds, slim. `lane` `all\|upcoming\|completed\|needs_brief`, `stage`, `q` (company/role/interviewer) |
| GET | `/processes` | live loops (`applied` `screen` `interview` `offer`) with round timeline, next/last round, `nextAction` |

### Positions

| method | path | notes |
|--|--|--|
| GET | `/positions` | `status` (`hot` · `active` · `all` · comma list), `verdict` (`none` is unscored), `minScore`, `q` (title, company, location, team), `company`, `geoClass` (`home` keeps a listing that fits the profile market or names the profile city), `workplace`, `listingStatus`, `watch`, `sort` (`updated_desc` `score_desc` `company` `status` `first_seen_desc` `posted_desc` `posted_asc` `last_changed_desc` `title` `workplace` `geo` `location`), `page`/`pageSize` or `cursor`. Slim rows. The desk opens an unscored list on `posted_desc` |
| POST | `/positions` | `{url, companyName?, status?}` — fetch the JD, create or refresh, enqueue triage. `201` when created |
| GET | `/positions/:idOrSlug` | full detail: company, JD text, revisions, evaluations, materials, careerOps stamp |
| PATCH | `/positions/:idOrSlug` | `title status priority primaryUrl resumeSurface nextAction notes watchEnabled appliedAt equityNotes archiveReason geoNotes metadata` — status changes write a timeline event; `applied` stamps `appliedAt` |
| POST | `/positions/:idOrSlug/archive` | `{reason?}` |
| POST | `/positions/:idOrSlug/refresh` | re-fetch the JD now (revision if changed) |
| POST | `/positions/:idOrSlug/notes` | `{title?, body?}` → timeline note |
| POST | `/positions/:idOrSlug/actions/:action` | `action` ∈ `triage evaluate materials company_research jd_review form_answers listing_classify`; body `{force?, surface?}`; enqueues (`202`) or runs inline with `?sync=1`. No model key returns `VALIDATION_ERROR`. A synchronous run the model gate refuses returns `LLM_GATE` |
| GET | `/positions/:idOrSlug/questions?sort=` | application prompts and drafted answers |
| PATCH | `/positions/:idOrSlug/questions/:qid` | `{answer?, status?}` `open` `answered` `skipped`. An empty answer is stored as null |
| GET | `/positions/:idOrSlug/timeline?limit=` | |
| GET | `/positions/:idOrSlug/revisions/:rev` | one JD revision with diffs |
| GET | `/positions/:idOrSlug/evaluations/:kind` | latest `evaluate` / `jd_review` / `company_research` |
| GET | `/positions/:idOrSlug/materials` | all versions |
| GET | `/positions/:idOrSlug/materials/current/:kind` | current `resume` / `cover` |
| POST | `/positions/:idOrSlug/materials` | `{kind, bodyMarkdown, title?, notes?, pdfBase64?, pdfFileName?}` — store a hand-edited version |
| GET | `/positions/materials/:materialId` | |
| PUT | `/positions/:idOrSlug/career-ops` | merge a career-ops stamp into `metadata.careerOps` |
| POST | `/positions/reconcile-career-ops` | bulk URL-first reconciliation. Dry run unless the body says otherwise |
| GET / POST | `/positions/:idOrSlug/people` | company-scoped contacts `{name, title?, linkedinUrl?, email?, notes?}` |
| DELETE | `/positions/:idOrSlug/people/:personId` | 404 if the person is not on this company |
| GET / POST | `/positions/:idOrSlug/interviews` | list is slim (metadata + char counts). POST body: `stage`, `title`, interviewer, `scheduledAt`/`occurredAt`, `status` `pending\|completed\|cancelled`, `outcome` `advanced\|hold\|rejected\|cancelled\|unclear`, notes/review/transcript markdown. A transcript queues `interview_brief` unless `skipBrief` |
| GET | `/positions/:idOrSlug/interviews/:interviewId` | full round including transcript + AI brief |
| PATCH / DELETE | `/positions/:idOrSlug/interviews/:interviewId` | |
| POST | `/positions/:idOrSlug/interviews/:interviewId/brief` | queue AI brief (`202`); `?sync=1` runs in-process |

### Companies

| method | path | notes |
|--|--|--|
| GET | `/companies` | `q`, `withPositions=true`, `page`/`pageSize`; position counts (total / hot / pass) |
| GET | `/companies/:idOrSlug` | detail, positions, boards, latest research |
| PATCH | `/companies/:idOrSlug` | |
| POST | `/companies/:idOrSlug/actions/research` | enqueue `company_research` |

### Radar

| method | path | notes |
|--|--|--|
| GET | `/radar/discovery` | `lane` (`passed` `marginal` `filtered` `all`), `hours`, `q`, `reason`, `sort` (`observed_desc` `posted_desc` `posted_asc` `title` `location`), cursor pagination. The desk opens on `posted_desc` |
| GET | `/radar/discovery/summary?hours=` | seen / passed / marginal / sources |
| POST | `/radar/discovery/:id/promote` | create a position from a discovery row and triage it |
| GET | `/radar/deltas?hours=` | board deltas |
| GET / POST | `/radar/boards` | `{company, provider, token?, careersUrl?, tags?}` — ATS auto-detected from the URL |
| PATCH | `/radar/boards/:id` | `{enabled?, notes?, tags?}` |
| POST | `/radar/boards/:id/scan?force=` | |
| POST | `/radar/boards/scan-all?all=&limit=` | due boards, or every enabled board |
| GET / POST | `/radar/watches` | `{url, label?, positionId?}` |
| DELETE | `/radar/watches/:id` | |

### Approvals (autopilot inbox)

| method | path | notes |
|--|--|--|
| GET | `/approvals?status=&limit=` | `pending` (default) `approved` `dismissed` `all` |
| GET | `/approvals/summary` | pending count, untriaged positions, auto jobs last 24 h |
| POST | `/approvals/:id/approve` | applies the payload (status change, archive, accept drafts) |
| POST | `/approvals/:id/dismiss` | |
| POST | `/approvals/resolve` | `{ids, decision}` bulk |

### Chat

| method | path | notes |
|--|--|--|
| GET | `/chat/threads?scope=&positionId=&companyId=&limit=` | |
| POST | `/chat/threads` | `{scope, positionId?, companyId?, title?}` |
| GET / DELETE | `/chat/threads/:id` | |
| POST | `/chat/threads/:id/messages` | `{text}` → **SSE** stream of `delta` · `tool_call` · `tool_result` · `message` · `done` · `error` |

### Settings

| method | path | notes |
|--|--|--|
| GET / PATCH | `/settings` | the whole document / deep-merge a partial (`gate`, `triage`, `scan`, `retention`, `llm.operations`, `autopilot`, `chat`, `notifications`) |
| GET | `/settings/notifications` | channels, events, quiet hours, chat model, `wahaConfigured` |
| POST | `/settings/notifications/test` | `{channel}` `desk` `new` `process` `research` `chat` — enqueue a test WhatsApp send |
| GET / PATCH | `/settings/profile` | identity, master resume, surfaces, scout brief |
| GET | `/settings/llm/models?refresh=1` | `/v1/models` catalog (cached) |
| GET | `/settings/llm/status` | per-operation model, enabled, cap, calls today |
| GET | `/settings/llm/runs?limit=` | recent `llm_runs` |
| GET | `/settings/llm/runs/facets` | filter values for the AI logs page |
| GET | `/settings/llm/runs/:id` | one run |
| POST | `/settings/llm/retry` | `{hours?, scope?: failed\|failed_and_missing, operations?, limit?}` — re-enqueue latest failed LLM ops (202). `failed_and_missing` also triages opens with no successful triage. Does not re-run successful evaluate/materials |
| POST | `/settings/llm/test` | `{model}` smoke prompt |
| GET | `/settings/autopilot` | config + preset definitions |
| POST | `/settings/autopilot/preset` | `{preset}` `manual` / `assisted` / `autopilot` |
| GET | `/settings/system` | version, db, queue, retention, LLM, browser |
| GET | `/settings/system/browser` | job-scout Steel `/v1/health` + Playwright MCP connectivity (not the shared human UI) |
| GET | `/settings/system/jobs?status=&type=&limit=` | queue rows |
| POST | `/settings/system/jobs` | `{type, payload}` enqueue anything (admin) |
| POST | `/settings/system/retention` | run retention now |
| GET / POST | `/settings/tokens` | `{name, scopes}` — plaintext shown once |
| DELETE | `/settings/tokens/:id` | |

### Misc

| method | path | notes |
|--|--|--|
| POST | `/webhooks/waha` | a WAHA server inbound. Public path; requires `X-Api-Key` = `WAHA_WEBHOOK_KEY`. Handles `event=message` only (`message.any` is ignored). Runs the desk agent for **job-scout chat** only; never apply |
| GET | `/health` · `/ready` | probes; `health` carries `version` |
| POST | `/auth/login` · GET `/auth/status` | session |
| GET | `/clip?url=` | session-auth re-fetch intake (ATS URLs); redirects to `/positions/:slug` |
| POST | `/clip` | form or JSON `{url,title,text}` snapshot; cross-site submissions require a same-origin confirmation; no re-fetch when `text` is present; redirects to `/positions/:slug` |
| ALL | `/mcp` | MCP Streamable HTTP, see [MCP.md](./MCP.md) |

## Examples

```bash
B=http://localhost:8080/api/v1; H='Authorization: Bearer dev-agent-token'

# add a position from a URL (fetch → gate → triage)
curl -s -X POST $B/positions -H "$H" -H 'content-type: application/json' \
  -d '{"url":"https://job-boards.greenhouse.io/postscript/jobs/8637343002"}'

# PASS verdicts waiting for a decision, best first
curl -s "$B/positions?status=triaged&verdict=pass&sort=score_desc" -H "$H"

# evaluate inline and get the report
curl -s -X POST "$B/positions/<slug>/actions/evaluate?sync=1" -H "$H"

# switch autopilot off
curl -s -X POST $B/settings/autopilot/preset -H "$H" -H 'content-type: application/json' -d '{"preset":"manual"}'

# chat, streamed
T=$(curl -s -X POST $B/chat/threads -H "$H" -H 'content-type: application/json' -d '{"scope":"global"}' | jq -r .data.id)
curl -N -X POST $B/chat/threads/$T/messages -H "$H" -H 'content-type: application/json' -d '{"text":"what should I decide today?"}'
```

Authentication, scope requirements, trusted origins and deployment migration: [SECURITY.md](SECURITY.md).

`POST /api/v1/positions/refresh-stale-triage` accepts `{ "limit": 25, "dryRun": true }`. Preview is the default. Set `dryRun: false` to queue up to 25 stale PASS candidates from the decision queue. Refresh jobs preserve pipeline stages and do not run autopilot or send notifications. Existing queued triage jobs are reported as deduplicated.
