# MCP

The API includes an MCP server for reading positions, managing the pipeline and running AI operations. WhatsApp chat uses the local chat tools through its webhook.

| | |
|--|--|
| **Endpoint** | `POST https://<host>/mcp` (Streamable HTTP, stateless: one POST per message, any replica can answer) |
| **SDK** | `@modelcontextprotocol/server` with `legacy: "stateless"`, so 2025-era clients still work |
| **Auth** | `Authorization: Bearer <token>` — the seed token, or a Settings › System token with scope `mcp`, `agent` or `admin` |
| **Payloads** | JSON, with a 100 KB result limit. Use cursor pagination where offered and small limits for `work_queue`; oversized results currently truncate the JSON text |
| **Code** | `apps/api/src/mcp/server.ts` (tools) · `apps/api/src/mcp/handler.ts` (HTTP + auth) |

## Tools

### Read

| tool | |
|--|--|
| `server_info` | identity, version, endpoints, LLM status |
| `market_summary` | counts by status/verdict, discovery lanes for the last N hours, LLM usage |
| `list_positions` | slim rows; `status` (comma list, `hot`, `active`, `all`), `verdict`, `q`, `company`, `minScore`, `sort`, cursor pagination |
| `get_position` | full detail: company, current JD text, revisions, evaluations, materials |
| `scout_context` | everything to reason about one role: position, triage JSON, JD text, latest evaluation summary, profile brief |
| `get_evaluation` | latest markdown + JSON for `evaluate` / `jd_review` / `company_research` |
| `get_materials` | current resume + cover markdown |
| `work_queue` | decision lanes: PASS awaiting a decision, review (including a deliberate operator override), applied, marginal, and failed triage that has no operator override. Closed rows are left out |
| `list_discovery` | `lane`, `hours`, `q`, `reason` prefix; cursor pagination |
| `list_companies` / `get_company` | companies with counts / detail with positions and latest research |
| `get_profile` / `get_identity` | operator profile / identity + master resume + scout brief markdown |
| `list_activity` | timeline events, optionally for one position |
| `list_changes` | positions and evaluations updated after an ISO timestamp — the sync primitive |
| `list_processes` | live loops (applied/screen/interview/offer) with round timeline |
| `list_all_interviews` | every round across positions (`lane`, `q`, `stage`); slim |
| `list_interviews` | rounds for a position (slim: metadata + char counts, not transcript bodies) |
| `get_interview` | one round with notes, review, transcript, AI brief |
| `list_questions` | ATS form prompts and drafted answers for a position |

### Write

| tool | |
|--|--|
| `intake` | create/refresh a position from a job URL; queues triage when a model key is set |
| `refresh_jd` | re-fetch the ATS page; revision if changed |
| `update_position` | PATCH status, priority, notes, nextAction, resumeSurface, watchEnabled, appliedAt |
| `set_position_status` | any pipeline status; `archived` requires a reason |
| `log_activity` | append a timeline note |
| `upsert_interview` | create/patch a screen or interview (transcript queues an AI brief unless `skipBrief`) |
| `brief_interview` | queue or `sync` the `interview_brief` model vs JD + company pack. A transcript does not queue a brief when no model key is set |
| `update_question` | set `answer` and/or `status` (`open` `answered` `skipped`) |
| `run_llm` | run `triage` / `evaluate` / `materials` / `jd_review` / `form_answers` / `listing_classify` synchronously with the model from Settings › AI |
| `run_discovery_radar` | enqueue board scans for due boards (`all=true` forces every enabled board) |
| `promote_discovery` | create a position from a discovery row and triage it |
| `retry_failed_llm` | re-enqueue latest failed LLM ops (`hours`, `scope=failed|failed_and_missing`). Does not re-run successful evaluate/materials |

### career-ops bridge

| tool | |
|--|--|
| `upsert_career_ops_stamp` | store tracker id / score / status / report path on `positions.metadata.careerOps` |
| `list_career_ops_stamps` | every position carrying a stamp |
| `reconcile_career_ops` | bulk URL-first reconciliation. Dry run by default |
| `create_position_from_career_ops` | position for a tracker row job-scout does not know; fetches the URL when reachable, else a manual record titled from the tracker role |
| `write_resume_eval` | store an evaluation produced elsewhere as an `evaluate` record and stamp it |

### Compatibility aliases

`set_match_override` (`human_skip` archives, `match` → review) and `list_eval_inbox` (review without evaluation) keep older agent prompts working.

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

## Verify

```bash
curl -sS -X POST http://localhost:8080/mcp \
  -H "Authorization: Bearer $JOB_SCOUT_TOKEN" \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

`refresh_stale_triage` previews the top stale PASS decision candidates by default (`limit` 1–25). Set `dryRun=false` to enqueue score-only refreshes without moving stages, running autopilot or sending notifications. `run_llm` with `operation=triage` now reruns stale or unknown-profile scores without requiring `force`; unchanged current-profile scores remain cached.
