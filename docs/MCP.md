# MCP

The API includes an MCP server for reading positions, managing the pipeline and running AI operations. WhatsApp chat uses the local chat tools through its webhook.

| | |
|--|--|
| **Endpoint** | `POST https://<host>/mcp` (Streamable HTTP, stateless: one POST per message, any replica can answer) |
| **SDK** | `@modelcontextprotocol/server` with `legacy: "stateless"`, so 2025-era clients still work |
| **Auth** | `Authorization: Bearer <token>` — the seed token, or a Settings › System token with scope `mcp`, `agent` or `admin` |
| **Payloads** | JSON, with a 100 KB UTF-8 result limit. Oversized results return `isError: true` with `RESULT_TOO_LARGE`; request fewer rows or narrower filters. JSON is never cut mid-response |
| **Code** | `apps/api/src/mcp/server.ts` (tools) · `apps/api/src/mcp/handler.ts` (HTTP + auth) |

## Paging

`list_positions` and `list_changes` page with an opaque `nextCursor`. Pass it back unchanged as `cursor`, with the same filters and sort, until it is `null`. A cursor replayed with other filters or another sort is refused with `code: "invalid_cursor"`; so is an old-style `timestamp|id` cursor. `list_positions` cursors work with every `sort`: the default `updated_desc` (and `updated_asc`) page by keyset on `(updatedAt, id)` at full database precision, so rows that share a timestamp are neither skipped nor repeated; other sorts page by offset over a total order (`id` breaks ties). A row whose sort key changes between pages can move; for a full enumeration prefer `first_seen_asc`, which background checks do not change.

Rows are lean by default. `list_positions` rows carry `id`, `slug`, `title`, `company` (`slug`, `name`), `status`, `archiveReason`, `priority`, `primaryUrl`, `triageScore`, `triageVerdict`, `triageOneLiner`, `listingStatus`, `geoClass`, `workplace`, `appliedAt`, `lastChangedAt`, `updatedAt`, `careerOps` (tracker id, score, status, report path, sync times), `duplicateOfId`, `triageStale` and `careerOpsStale`. `fields: "full"` adds salary, `locationRaw`, `departments`, `postedAt`, repost, ATS, family and duplicate-count fields. Neither includes `triageJson` or JD text: use `get_position` or `scout_context`.

Each page is cut to about 80 KB of rows so it stays under the result limit. A cut page has `truncated: true`, fewer rows than `pageSize`, and a `nextCursor` that resumes after its last row. `total` counts the whole result, not the page.

## Changes

`list_changes` returns positions whose `updatedAt` is after `since`, oldest first, then evaluations created after `since`. `updatedAt` moves when something the operator sees changes: status, notes and other edits, a JD revision, triage, a listing-fact change. It does not move for an unchanged watch or refresh check (that records `lastCheckedAt`), a form-question harvest, or a career-ops stamp, so those rows are not handed back. `lastChangedAt` on each row marks the last material JD change.

Positions are drained first; evaluations start on the page that returns the last changed position, and later pages carry `positions: []`. Follow `nextCursor` with the same `since`. `now` is fixed by the first page and repeated on every page: once `nextCursor` is `null`, store that `now` as the next `since`. Rows are lean, like `list_positions`; `fields: "full"` returns the fuller list row. Pages are cut to the byte budget described under [Paging](#paging).

## Tools

### Read

| tool | |
|--|--|
| `server_info` | identity, version, endpoints, LLM status |
| `market_summary` | counts by status/verdict, discovery lanes for the last N hours, LLM usage |
| `list_positions` | lean rows; `status` (comma list, `hot`, `active`, `all`), `verdict`, `q`, `company`, `minScore`, `sort`, `fields`, cursor pagination. See [Paging](#paging) |
| `get_position` | full detail: company, current JD text, revisions, evaluations, materials |
| `scout_context` | everything to reason about one role: position, triage JSON, JD text, latest evaluation summary, profile brief |
| `get_evaluation` | latest markdown + JSON for `evaluate` / `jd_review` / `company_research` |
| `get_materials` | current resume + cover markdown |
| `work_queue` | decision lanes: PASS awaiting a decision, review (including a deliberate operator override), applied, marginal, and failed triage that has no operator override. Closed rows are left out. Compact summaries; `lane`, `page`, `limit` (default 20 per lane), with totals and `nextPage` in `pagination`. Use `get_position` for full details |
| `list_discovery` | `lane`, `hours`, `q`, `reason` prefix; cursor pagination |
| `list_companies` / `get_company` | companies with counts / detail with positions and latest research |
| `get_profile` / `get_identity` | operator profile / identity + master resume + scout brief markdown |
| `list_activity` | timeline events, optionally for one position |
| `list_changes` | lean positions, then evaluations, changed after an ISO `since` — the sync primitive. `limit` rows per page (default 200), `cursor`, `fields`. See [Changes](#changes) |
| `list_processes` | live loops (applied/screen/interview/offer) with round timeline |
| `list_all_interviews` | every round across positions (`lane`, `q`, `stage`); slim |
| `list_interviews` | rounds for a position (slim: metadata + char counts, not transcript bodies) |
| `get_interview` | one round with notes, review, transcript, AI brief |
| `list_questions` | ATS form prompts and drafted answers for a position |
| `screen_recruiter_threat` | structured risk verdict for inbound recruiter outreach: `domainOrEmail`, optional `messageText`. Checks the operator blocklist (`THREAT_BLOCKLIST_DOMAINS`, empty by default), registered-domain age via a public RDAP lookup at `rdap.org`, free-mail senders and installer/script lures. Message text is untrusted input and is not echoed back. A failed RDAP lookup skips that signal |

### Write

| tool | |
|--|--|
| `intake` | create/refresh a position from a job URL; queues triage when a model key is set |
| `refresh_jd` | re-fetch the ATS page; revision if changed. Refused with `frozen:<status>` at interview/offer unless `force: true` (explicit operator refresh) |
| `update_position` | PATCH status, priority, notes, nextAction, resumeSurface, watchEnabled, appliedAt. The career-ops guard below applies to a `skip`/`archived` status; the other fields still apply. `status: materials` follows the materials rule below |
| `set_position_status` | any pipeline status; `archived` requires a reason. Subject to the career-ops guard below; optional `actor` names the calling agent (see [Attribution](#attribution)); `materials` follows the materials rule below |
| `log_activity` | append a timeline note |
| `upsert_interview` | create/patch a screen or interview (transcript queues an AI brief unless `skipBrief`). `status` is `pending` (default), `completed` or `cancelled`; `scheduled` and `upcoming` are stored as `pending`, `canceled` as `cancelled`, `done` as `completed`. `outcome` is `advanced` `hold` `rejected` `cancelled` `unclear` |
| `brief_interview` | queue or `sync` the `interview_brief` model vs JD + company pack. A transcript does not queue a brief when no model key is set |
| `update_question` | set `answer` and/or `status` (`open` `answered` `skipped`) |
| `run_llm` | run `triage` / `evaluate` / `materials` / `jd_review` / `form_answers` / `listing_classify` synchronously with the model from Settings › AI |
| `run_discovery_radar` | enqueue board scans for due boards (`all=true` forces every enabled board) |
| `promote_discovery` | create a position from a discovery row and triage it |
| `retry_failed_llm` | re-enqueue latest failed LLM ops (`hours`, `scope=failed|failed_and_missing`). Does not re-run successful evaluate/materials |

**Write echoes.** `update_position`, `set_position_status`, `set_match_override` and `create_position_from_career_ops` return a compact position summary: `id`, `slug`, `title`, `company` (`slug`, `name`), `status`, `archiveReason`, `priority`, `primaryUrl`, `workplace`, `geoClass`, `geoNotes`, `listingStatus`, `nextAction`, `notes` (cut at 2,000 chars), `resumeSurface`, `watchEnabled`, `appliedAt`, `lastChangedAt`, `updatedAt`, the career-ops `trackerId`/`status`/`score` when stamped, `classificationOverride` when set, and `statusApplied`/`statusNote` when the career-ops guard declined a status. `triageJson`, `metadata`, JD text and revisions are not echoed. Pass `verbose: true` for the full row (`create_position_from_career_ops`: the full `get_position` detail). `upsert_interview` returns the round's metadata with `notesChars`, `notesMarkdownChars`, `reviewChars`, `transcriptChars`, `aiBriefChars` and `briefJobId`; `verbose: true` returns the bodies, and `get_interview` reads them later.

**Materials rule.** `materials` means materials exist. `update_position` and `set_position_status` refuse `status: materials` with a `materials_missing: …` error while the position has no non-failed resume or cover in job-scout and no career-ops stamp with `pdfPath`; the status is left unchanged. Generate drafts first (`run_llm` `materials`, which moves the stage itself) or, when career-ops packaged the application, call `upsert_career_ops_stamp` with `pdfPath` and then set the status.

### career-ops bridge

| tool | |
|--|--|
| `upsert_career_ops_stamp` | store tracker id / score / status / report path on `positions.metadata.careerOps` |
| `list_career_ops_stamps` | every position carrying a stamp |
| `reconcile_career_ops` | bulk URL-first reconciliation. Dry run by default |
| `create_position_from_career_ops` | position for a tracker row job-scout does not know; fetches the URL when reachable, else a manual record titled from the tracker role |
| `write_resume_eval` | store an evaluation produced elsewhere as an `evaluate` record and stamp it |

### Compatibility aliases

`set_match_override` (`human_skip` archives, `match` → review) and `list_eval_inbox` (review without evaluation) keep older agent prompts working. `human_skip` is subject to the career-ops guard below.

### career-ops skip/archive guard

A career-ops tracker label never removes a role from the pipeline on its own. `update_position`, `set_position_status` and `set_match_override` (`human_skip`) record a `skip` or `archived` request as a timeline note (`career-ops says skip; not applied`) instead of applying it when the call comes from the career-ops sync:

- the calling agent is the career-ops sync: the MCP actor is the API token name, so name the sync's token `career-ops` or `career-ops-…` (for example `career-ops-sync`);
- or the call passes `source: "career-ops"` (`update_position`, `set_position_status`);
- or the `note` starts with `career-ops` (`set_position_status`).

Other statuses (applied, interview, rejected, …) apply normally. Tokens with any other name are treated as a person or operator agent: their skip/archive applies, and their restore of an archived or skipped role stops triage from re-archiving it until a person archives or skips it again.

## External tracker integration

The `career_ops` tools support synchronizing an external application tracker. They store a tracker reference on each position and reconcile rows by posting URL. Preview reconciliation before applying it. The tracker format and synchronization client belong to the integration using these tools.

Status mapping: Evaluated → review/materials · Applied → applied · Responded → screen · Interview → interview · Offer → offer · Rejected → rejected.

## Client configuration

Grok CLI (`~/.grok/config.toml`):

```toml
[mcp_servers.job-scout]
url = "http://localhost:8080/mcp"
enabled = true
startup_timeout_sec = 45
tool_timeout_sec = 120

[mcp_servers.job-scout.headers]
Authorization = "Bearer <token from Settings › System>"
```

Cursor / Claude Code: same URL and header in the MCP server list. Mint one token per client so they can be revoked independently.

## Attribution

Writes record an actor in the position timeline. By default it is the token's name. When several agents share one token, each can name itself with an `X-Job-Scout-Actor` header (or `X-Agent-Name`); `set_position_status` also accepts an `actor` argument, which takes precedence. The timeline then shows `<caller> via <token name>`, for example `pipeline-sync via shared-agent`. The caller name is reduced to letters, digits and `. _ : @ -`, capped at 64 characters, and the token name is always kept, so a header cannot impersonate another token or the operator. Automation rules still follow the token: a caller using an automated token stays automated.

```toml
[mcp_servers.job-scout.headers]
Authorization = "Bearer <token from Settings › System>"
X-Job-Scout-Actor = "pipeline-sync"
```

## Verify

```bash
curl -sS -X POST http://localhost:8080/mcp \
  -H "Authorization: Bearer $JOB_SCOUT_TOKEN" \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

`refresh_stale_triage` previews the top stale PASS decision candidates by default (`limit` 1–25). Set `dryRun=false` to enqueue score-only refreshes without moving stages, running autopilot or sending notifications. `run_llm` with `operation=triage` now reruns stale or unknown-profile scores without requiring `force`; unchanged current-profile scores remain cached.

`scout_context` includes the same current profile facts used by triage, alongside the scout brief, background and resume.
