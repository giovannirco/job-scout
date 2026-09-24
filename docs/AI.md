# AI: operations, autopilot, chat, browser

job-scout talks to one OpenAI-compatible gateway (`OPENAI_BASE_URL`, `OPENAI_API_KEY`; an OpenAI-compatible gateway in production). There is no other AI integration: no agent framework, no message bus, no separate harness. The model is a function the worker and the API call, and every call is a row in `llm_runs`.

## Operations

| operation | when | model shape | output |
|--|--|--|--|
| `triage` | a listing passes the gate; `Re-triage` on a position; MCP `run_llm` | cheap, fast (default gemini-flash-lite class) | `json_schema`: score 1–5, verdict pass/marginal/fail, one-liner, hard DQs → `positions.triage_*` |
| `evaluate` | you, autopilot, MCP | strong | markdown A–H report + trailing JSON summary (score, verdict apply/consider/skip, headline) → `evaluations` |
| `company_research` | you, autopilot, MCP | strong | markdown dossier + summary → `evaluations(kind=company_research)`, reused across the company's positions |
| `jd_review` | a material JD change; you | mid | what changed and whether it matters → `evaluations(kind=jd_review)` |
| `materials` | you, autopilot, MCP | strong | tailored resume + cover markdown → `application_materials` (surface: ai / sre / platform) |
| `chat` | the dock chat | strong, streaming, tool calls | thread messages → `chat_threads` |
| `interview_brief` | transcript (or notes) stored on a round; Position › Interviews › AI brief; MCP `brief_interview` | same class as evaluate (inherits that model if unset) | markdown debrief + JSON (jd hits/misses, signals, next-round prep) → `interviews.ai_brief_*` |
| `listing_classify` | a messy ATS location; you; MCP `run_llm` | cheap | tightens geo. It does not weaken a hard block |
| `form_answers` | you; the Autopilot preset after evaluate; MCP `run_llm` | mid | drafted answers on `application_questions`. Nothing is submitted |

Settings › AI: per operation a **model** (from the cached `/v1/models` catalog, refreshable), **enabled**, **daily cap** (0 = none), optional **temperature**. `POST /settings/llm/test` runs a smoke prompt on any model. Settings › AI also lists recent runs with latency, tokens and status. **Retry failed** (`POST /settings/llm/retry`) re-enqueues the latest failed ops in a window; `scope=failed_and_missing` also triages open positions with no successful triage. It does not re-run successful evaluate/materials. Daily caps still apply.

Prompt inputs are bounded (`triage.jdMaxChars`, default 6000) and every prompt includes the **scout brief** when one is written (Profile). Leave it empty until then. A stored brief that still says “fill this in under settings” is treated as empty and is not sent. `packages/llm/src/brief.ts` still holds that old starter text; new profiles do not insert it.

## The gate (free)

Before any model call, `packages/shared/src/gate.ts` rejects listings with no model. Rejections land in `discovery_feed` with a reason and stay under Discovery › Filtered.

| check | what it does |
|--|--|
| Title include | Profile **target roles** replace this list. `java` does not match JavaScript. `engineer` and `developer` match each other. `backend engineer` also matches `Backend/API Engineer` and `Engineer, Backend`. |
| Title exclude | `junior` also excludes new grad, early career, and graduate. A north star that says “not infrastructure” also excludes infrastructure, Kubernetes, DevOps, SRE, Linux, embedded, kernel, and the rest of `titleExcludesFromNorthStar`. A paragraph that asks for backend and does not ask for frontend, data engineer, or support/solutions/quality also excludes those titles. A paragraph that uses none of those phrases does not filter titles. |
| Named office | A city or single country with no remote wording does not pass, even when unknown geo is allowed. A country list is not one office. A location that starts with remote or distributed stays remote. |
| Home location | A US city drops a remote role that requires another country, and keeps “Remote - US only”. A Brazil city drops US-only roles. Other cities do not filter. The pipeline chip says **home** when the listing fits that market, or when the location names the profile city. A location that is only “Remote” is not home. Clearing the location does not restore archives. |
| Geo allow / block | Word lists. A block wins when both match, except `us only` / `usa only` when the profile is in the US. |
| Posting age | Default 14 days when a date is known. A job the board is still listing skips this check. |

Reasons include `title_exclude:<term>`, `title_no_include`, `geo_block:<term>`, `geo_unlisted`, `geo_home`, `geo_unknown`, and `stale:<days>d`.

A pass becomes a position with status `triaged` and no score. Triage runs only when a model key is set and the triage operation is enabled. An untouched scan filing that later misses the gate is archived, and its discovery row leaves the passed lane. A URL pasted by hand, with no discovery row, stays.

## Autopilot

`Settings › Autopilot` stores an `AutopilotConfig`; hooks in `packages/core/src/autopilot.ts` run after each step and either enqueue the next job (`payload.auto = true`) or create an `approvals` row.

| rule | field | Manual | Assisted | Autopilot |
|--|--|--|--|--|
| triage every gated listing | `triageNew` | off | on | on |
| evaluate after triage | `evaluate.mode` / `minTriageScore` | off | threshold ≥ 4.0 | all PASS |
| company research | `companyResearch.mode` / `staleDays` | off | on evaluate, skip if < 90 d old | on evaluate |
| re-review a changed JD | `jdReview.mode` | off | hot positions only | any active position |
| draft resume + cover | `materials.mode` / `minEvaluateScore` | off | off | threshold ≥ 3.5 |
| file apply/skip suggestion after evaluate | `suggestStatus` | off | on | on |
| daily budget | `budget.dailyCalls` / `dailyTokens` | 0 = none | 0 | 0 |

Editing any field switches the preset to **custom**. `POST /settings/autopilot/preset` applies a preset wholesale.

Guarantees:

- **Status never changes by itself.** An `apply` verdict files a `status_suggestion` (→ materials); a `skip` verdict files an `archive_suggestion`. You approve or dismiss in the Inbox, the Today page, or the dock.
- **Materials drafted by autopilot always land in the Inbox** as a `materials_draft`; they do not move the position to `materials`.
- **Budgets are hard stops.** Per-operation `dailyCap` first, then the global `budget`. A job that hits one is parked for an hour, not failed.
- **Dedupe.** Every auto-enqueued job carries a `dedupeKey` (`evaluate:<position>`, `company_research:<company>`, `jd_review:<position>:<rev>`), so a burst of changes never fans out.
- **Approvals dedupe too**: one pending suggestion per position and kind.

`GET /approvals/summary` (and Today › Machine) shows pending approvals, untriaged positions, and auto jobs of the last 24 h.

## Chat agent

`packages/core/src/chat.ts`. A thread has a **scope** — `global`, `position` or `company` — and the system prompt is built from that scope: profile brief, the position's triage/evaluation/JD text, or the company's positions and research. The UI sets the scope from the page you are on; the dock keeps one thread list per scope.

Each user message runs a tool-calling loop (`ChatConfig.maxSteps`, default 12) over `chatStream`, emitting SSE events: `delta`, `tool_call`, `tool_result`, `message`, `done`, `error`.

Local tools: `search_positions`, `get_position`, `get_evaluation`, `get_materials`, `get_company`, `search_companies`, `today`, `list_approvals`, `resolve_approval`, `set_position_status`, `add_note`, `run_operation`, `intake_url`, `list_processes`, `web_fetch`. `writeTools=false` hides the mutating ones. With `browserTools=true`, a configured browser, and `BROWSER_EGRESS_ISOLATED=1`, selected Playwright MCP navigation/read/lifecycle tools are available so the agent can open a public HTTP(S) job page and read it. Desk write permission never enables browser scripts, clicks, typing, form filling, or other external submission actions.

WhatsApp **job-scout chat** (`packages/core/src/whatsapp-inbox.ts`) is the same agent on Settings › Notifications `chat.model` (default **grok-4.6**), with writes on, over a durable global thread titled `WhatsApp · job-scout chat`. It can inspect process and intake a JD URL. It never applies. Inbound is a ClusterIP webhook, not the dock SSE.

## Browser plane

Optional. Point `STEEL_BASE_URL` at a [Steel Browser](https://github.com/steel-dev/steel-browser) reserved for job-scout, and `BROWSER_MCP_URL` at a [Playwright MCP](https://github.com/microsoft/playwright-mcp) attached to that same browser. Chrome's DevTools socket only accepts `localhost`, so the MCP process has to sit next to that browser. Leave both variables empty to skip the browser. Set `BROWSER_EGRESS_ISOLATED=1` only after applying the external egress controls described in [SECURITY.md](SECURITY.md).

| env | used by | for |
|--|--|--|
| `STEEL_BASE_URL` | worker + API | `renderUrl` → `POST {base}/v1/scrape` (never `/v1/sessions`) for JS-only ATS pages, closed-listing detection, `web_fetch` markdown |
| `BROWSER_MCP_URL` | API chat | the Playwright MCP tool set above, attached to the job-scout Steel |

Both empty = browser plane off; everything degrades to plain HTTP fetches. Settings › System shows the job-scout Steel `/v1/health` URL.

## Choosing models

`pnpm bench:models` (`scripts/bench-models.ts`) runs every operation with the production prompts
against a fixed set of positions, grades document outputs blind with several judge models, and
prints comparison tables. Recorded runs and the current per-operation decision live in
`docs/benchmarks/`. Short version (2026-09-03): a small fast model wins triage; reasoning models
win evaluate and research; avoid anything that rate-limits under bursts for triage.

## Cost and frequency

Nothing is on a model timer. Board scans and watch checks run on CronJobs (every 30 min / every 2 h) and cost nothing; the gate typically rejects > 90 % of listings; triage is called once per new listing that passes (a few hundred per day at the current board list) and evaluate/research only where the policy says so. Today › Machine and Settings › AI › Recent calls show the numbers; the `chat` operation shows up there like any other.

## Refreshing old decision scores

Triage now combines the current location, target roles, cash floor and career direction with the scout brief, identity and master resume. The stored fingerprint covers that effective input. Contact-only changes do not invalidate scores. Scores made before this prompt change need one refresh; missing historical fingerprints also count as stale.

Today marks old scores and provides **Refresh stale scores** for up to 25 PASS candidates in the decision queue. This action only recalculates triage: pipeline stages remain unchanged, and it does not trigger autopilot or notifications. Caps and model settings still apply. Refreshes are queued, so the warning disappears after the worker completes them. Chat includes the same freshness flag in its tool results.
