# MCP

job-scout **is** the MCP server; there is no separate process. Every capability of the UI is also a tool, so an agent can work the pipeline without scraping the API. WhatsApp desk chat is not MCP — it is the same local tools (`intake_url`, `list_processes`, …) invoked from `runChatTurn` on the API webhook.

| | |
|--|--|
| **Endpoint** | `POST https://<host>/mcp` (Streamable HTTP, stateless: one POST per message, any replica can answer) |
| **SDK** | `@modelcontextprotocol/server` with `legacy: "stateless"`, so 2025-era clients still work |
| **Auth** | `Authorization: Bearer <token>` — the seed token, or a Settings › System token with scope `mcp`, `agent` or `admin` |
| **Payloads** | pretty JSON up to 30 KB, compact above that, capped at 100 KB per result; paginate with `cursor` / `nextCursor` |
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
| `work_queue` | what needs the operator: PASS awaiting decision, review without evaluation, materials pending, applied > 7 d |
| `list_discovery` | `lane`, `hours`, `q`, `reason` prefix; cursor pagination |
| `list_companies` / `get_company` | companies with counts / detail with positions and latest research |
| `get_profile` / `get_identity` | operator profile / identity + master resume + scout brief markdown |
| `list_activity` | timeline events, optionally for one position |
| `list_changes` | positions and evaluations updated after an ISO timestamp — the sync primitive |
| `list_processes` | live loops (applied/screen/interview/offer) with round timeline |
| `list_all_interviews` | every round across positions (`lane`, `q`, `stage`); slim |
| `list_interviews` | rounds for a position (slim: metadata + char counts, not transcript bodies) |
| `get_interview` | one round with notes, review, transcript, AI brief |

### Write

| tool | |
|--|--|
| `intake` | create/refresh a position from a job URL; queues triage |
| `refresh_jd` | re-fetch the ATS page; revision if changed |
| `update_position` | PATCH status, priority, notes, nextAction, resumeSurface, watchEnabled, appliedAt |
| `set_position_status` | any pipeline status; `archived` requires a reason |
| `log_activity` | append a timeline note |
| `upsert_interview` | create/patch a screen or interview (transcript queues an AI brief unless `skipBrief`) |
| `brief_interview` | queue or `sync` the `interview_brief` model vs JD + company pack |
| `run_llm` | run `triage` / `evaluate` / `materials` / `jd_review` synchronously with the model from Settings › AI |
| `run_discovery_radar` | enqueue board scans for due boards (`all=true` forces every enabled board) |
| `promote_discovery` | create a position from a discovery row and triage it |
| `retry_failed_llm` | re-enqueue latest failed LLM ops (`hours`, `scope=failed|failed_and_missing`). Does not re-run successful evaluate/materials |

### career-ops bridge

| tool | |
|--|--|
| `upsert_career_ops_stamp` | store tracker id / score / status / report path on `positions.metadata.careerOps` |
| `list_career_ops_stamps` | every position carrying a stamp |
| `create_position_from_career_ops` | position for a tracker row job-scout does not know; fetches the URL when reachable, else a manual record titled from the tracker role |
| `write_resume_eval` | store an evaluation produced elsewhere as an `evaluate` record and stamp it |

### Compatibility aliases

`set_match_override` (`human_skip` archives, `match` → review) and `list_eval_inbox` (review without evaluation) keep older agent prompts working.

## career-ops

[career-ops](https://a separate tracker) stays its own project: a markdown tracker, reports and JDs in git. A skill on its side (`.claude/skills/job-scout-sync/`, user-layer, not committed there) reconciles two-way over these tools:

1. read every tracker row and every position (`list_positions status=all`, paged);
2. match by posting URL → ATS id → `js:<slug>` token in the tracker notes → company + role fuzzy;
3. matched rows get `upsert_career_ops_stamp` and the slug in the tracker; status becomes the lifecycle max and is written to the side that is behind (job-scout `archived` never wins over a tracker decision);
4. tracker rows without a position → `create_position_from_career_ops`; hot positions without a row → new tracker row, JD file, report from the stored evaluation;
5. `list_changes since=<lastSync>` keeps subsequent runs cheap.

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

grok -p --yolo --max-turns 6 \
  "Use job-scout MCP only: call server_info then list_positions status=hot pageSize=5. Summarize."
```
