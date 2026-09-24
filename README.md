# job-scout

**A personal career control plane.** It watches job boards, filters the noise deterministically, has a model triage and evaluate what is left, keeps an append-only history of every job description it has seen, drafts application materials, and gives you a chat agent that knows your pipeline and can drive a headless browser. It never applies on your behalf.

| | |
|--|--|
| **Stack** | TypeScript · Postgres (PGlite for dev/tests) · Hono API + embedded MCP · React 19 + Tailwind 4 · queue worker |
| **LLM** | any OpenAI-compatible `/v1` (`OPENAI_BASE_URL`, `OPENAI_API_KEY`). One model per operation, chosen in Settings › AI from the gateway's live `/v1/models` |
| **Browser** | optional [Steel Browser](https://github.com/steel-dev/steel-browser) + Playwright MCP. Empty `STEEL_BASE_URL` / `BROWSER_MCP_URL` means plain HTTP fetches |
| **Local** | `http://localhost:8080` · MCP at `/mcp` (Bearer) |

## How a listing flows

```text
board_scan ─► gate (titles · offices · home location · geo words · posting age)
                │ reject ──► Discovery › Filtered, with a reason
                └ pass ────► position (status = triaged, not scored yet)
                              │ no model key ──► stays unscored; chat and scoring stay off
                              └ key set ──► triage, then evaluate / research / materials
                                            as the autopilot policy allows
watch_check ─► a new JD revision only when the posting itself changed
```

Everything the model does is one of `triage`, `evaluate`, `materials`, `company_research`, `jd_review`, `chat`, `interview_brief`, `listing_classify`, and `form_answers`. Each has its own model, on/off switch, and daily cap, and every call is logged to `llm_runs`. Boards are scanned and gated with no key. The model only sees what passed, and only after a key is set.

## Without a model key

`pnpm dev` and `docker compose up` both run with no `OPENAI_API_KEY`. Discovery and the worker still scan. Nothing is scored.

- The pipeline opens on **All open**, not on PASS verdicts.
- Today counts unscored filings instead of decisions.
- Chat, triage, evaluate, materials, JD review, company research, and drafted form answers stay off. The position chat button is disabled with the others.
- Saving an interview transcript does not queue a brief.

## What the gate uses

Saving **target roles** replaces the title include list and rechecks listings from the last 7 days. A specialty word such as `java` is its own term, so it does not match JavaScript. `engineer` and `developer` match each other. A phrase such as `backend engineer` also matches `Backend/API Engineer` and `Engineer, Backend`. `junior` also excludes new grad, early career, and graduate.

A **named office** (a city or country, with no remote wording) does not pass, even when unknown geo is allowed. A list of countries is not one office. A location that starts with remote or distributed stays remote even when later segments name cities. A board that marks the job remote still passes.

A **US city** on the profile drops a remote role that requires another country, and it keeps a posting that says “Remote - US only”. A **Brazil** city drops US-only roles. Any other city does not filter. Clearing the location does not restore archived filings. The pipeline chip says **home** when the listing fits that market, or when the location names the profile city. A location that is only “Remote” is not home.

The north star is for the model, once a key exists. The same paragraph also changes the title gate, and only through a fixed list of phrases. “Not infrastructure” excludes infrastructure, Kubernetes, DevOps, SRE, Linux, embedded, kernel, and the related words in `titleExcludesFromNorthStar` (OpenStack, Ceph, Ubuntu, container image, data platform, and the rest of that list). A paragraph that asks for backend and does not ask for frontend also excludes frontend. The same pattern excludes data engineer, and l3 support, solutions engineer, and quality engineer, unless the paragraph asks for those. Settings says when the paragraph uses none of those phrases, so it is not filtering listings.

A job the board is still listing is not dropped because its first-published date is old. The 14-day age rule still applies when the listing was not just seen on a board.

An untouched scan filing that misses the gate is archived. A URL pasted by hand, with no discovery row, stays. Discovery stops listing an archived filing as passed. An unscored position shows its status without an empty score.

## Families

The same company, role, and requisition collapse to one pipeline row. A country stuck on the end of the title (`| UK | Remote`) does not split them. Senior and Staff stay separate. The location cell shows the first open place and a count (`Germany (Remote) +4`); the full list is the tooltip. Archived copies are not part of that count. When every known salary uses one currency, the comp cell spans the low and the high across those places. When the family is posted in more than one currency, each currency is shown.

Pay written as `$143,800.00 to $231,900.00` is read. A top amount that got glued to the next number (`$179,300,152`) is cut back to the band. A `$500` stipend is not a salary. Titles are trimmed. Search matches the title, the company, the location, and a team stored on the listing (`metadata.ats.departments`).

**Sources.** Discovery scans Greenhouse, Ashby, Lever, and BambooHR company boards. Bitso is the BambooHR board `bitso` (`https://bitso.bamboohr.com/careers`); the old Greenhouse token is not scanned. Market list scans are the Remote OK public JSON feed (`https://remoteok.com/api`), the We Work Remotely DevOps/Sysadmin RSS (`https://weworkremotely.com/categories/remote-devops-sysadmin-jobs.rss`), and Remotive software-dev JSON (`https://remotive.com/api/remote-jobs?category=software-dev`), title-filtered with `isCraftMatch`. Remote OK `sys admin` / `infosec` tags keep only when the title is craft. Other market indexes stay manual watches. A Settings bookmarklet POSTs the current tab (`url`, `title`, `body.innerText`) to a confirmation page so LinkedIn/Indeed JDs survive login walls — confirm the clip, and stay on the listing; it does not log in or apply for you.

A `noise_rebase` revision is this app rewriting stored text. The JD tab labels it **rewritten here** and groups those snapshots apart from employer edits. When the board description is cut off mid-sentence, the JD tab says so and does not invent the rest.

Leave the scout brief empty until you write one. A stored brief that still says “fill this in under settings” is treated as empty and is not sent to the model.

Greenhouse and Ashby application questions are stored with required, input type, and choices. The Forms tab shows a menu, a checklist, or a note to upload the file on the employer site. Drafted answers stay here. The app does not submit the application.

## Autopilot

How much runs unattended is a policy (Settings › Autopilot). Three presets plus custom:

| preset | what runs by itself |
|--|--|
| **Manual** | scan and gate only; nothing calls a model until you click |
| **Assisted** (default) | triage every gated listing → evaluate when triage ≥ 4.0 → research the company on evaluate → re-review hot positions whose JD changed → file apply/skip *suggestions* in the Inbox |
| **Autopilot** | Assisted + evaluate every PASS + re-review any open JD + draft resume/cover above a score bar (drafts land in the Inbox) |

Pipeline status never changes without an approval. A global daily call/token budget sits above the per-operation caps. Details in [docs/AI.md](./docs/AI.md).

## WhatsApp

Optional. Notifications are off until you set group chat ids under Settings › Notifications and provide `WAHA_BASE_URL` plus `WAHA_API_KEY`. Inbound desk chat is `POST /api/v1/webhooks/waha` with `X-Api-Key` = `WAHA_WEBHOOK_KEY`. Only the `message` event is handled. The agent can intake a job URL. It never applies.

## UI

Dark/light. `⌘K` palette for positions, companies and actions. A right-hand dock with **Wire** (live worker activity), **Inbox** (approvals) and **Chat** (agent scoped to the page you are on: global, one position, one company).

| page | what it is for |
|--|--|
| **Today** | funnel, unscored filings or PASS verdicts, approvals, JD changes, interviews, follow-ups, model usage and budget |
| **Pipeline** | every position as a table (`j`/`k`/`Enter`/`o`) or a board; filters on status, verdict, workplace, geo (including home). Opens on the employer posted date |
| **Process** | live loops (`applied`, `screen`, `interview`, `offer`) |
| **Interviews** | rounds across positions: transcripts, reviews, AI briefs |
| **Discovery** | what the scanners saw: passed, filtered, board deltas. Opens on the employer posted date |
| **Sources** | boards and watches |
| **Companies** | grid or table, with research and positions per company. The careers link is the board, not one opening. A company with no website links the careers host when that host is not the ATS |
| **Inbox** | autopilot suggestions and drafts to approve or dismiss |
| **AI logs** | recent model calls |
| **Position** | status stepper · Brief · Evaluation · JD · Materials · Forms · Company · History |
| **Settings** | Profile · Gate · AI models · Autopilot · **Notifications** (WhatsApp groups) · Appearance · System (queue, retention, tokens, job-scout Steel health) |

## Quickstart

```bash
cp .env.example .env         # leave DATABASE_URL unset for embedded PGlite
pnpm install
pnpm dev                     # API + UI (Vite) + embedded worker on http://localhost:8080
pnpm test                    # vitest on PGlite
```

Point it at a gateway with `OPENAI_BASE_URL` / `OPENAI_API_KEY`, then pick models under Settings › AI. Set a random `API_TOKEN_SEED` for agent/MCP access; there is no default token. See [security and private runtime deployment](docs/SECURITY.md).

Same stack in Docker. Postgres is included. The model gateway is not: set `OPENAI_API_KEY` in `.env`, and set `COMPOSE_OPENAI_BASE_URL` if the gateway is not on the host at port 8317.

```bash
cp .env.example .env
docker compose up --build          # http://localhost:8080  (auth mode dev, no password)
```

Separate processes, as deployed:

```bash
pnpm dev:api                 # apps/api    — Hono, MCP, serves apps/web/dist in prod
pnpm dev:worker              # apps/worker — queue consumer + in-process scheduler
pnpm once discovery|watch|retention   # one-shot entrypoints used by the CronJobs
pnpm db:generate             # drizzle-kit: new migration from schema.ts
```

## Layout

```text
apps/api/          Hono routes by resource · auth · mcp/ (39 tools) · serves the web bundle
apps/worker/       loop.ts (job types, retries, stale requeue) · once.ts (cron entry)
apps/web/          React app — ui/kit.tsx primitives · frame/ (sidebar, dock, chat, palette) · pages/
packages/core/     services shared by api + worker: positions, scan, triage, evaluate, materials,
                   autopilot, chat, WAHA notify/inbox, browser, settings, retention, radar
packages/llm/      OpenAI-compatible client (json_schema, document, streaming tool calls) · prompts · scout brief
packages/db/       drizzle schema + migrations · Postgres or PGlite client
packages/shared/   gate · settings schema · classify · salary · hash · types
packages/ats/      Greenhouse / Ashby / Lever / BambooHR / Remote OK / Remotive / We Work Remotely / generic HTML fetchers, optional browser renderer
packages/desk-ui/  vendored @desk-ui/api-client (fetch envelope + React Query hooks)
deploy/            Dockerfile · compose · helm/job-scout (chart + dashboards/job-scout.json)
scripts/           one-off importers (previous-generation database → current schema), model benchmark (`pnpm bench:models`, results in docs/benchmarks/)
docs/              ARCHITECTURE · AI · DATA-MODEL · API · MCP · PRODUCT · OBSERVABILITY
```

## MCP and career-ops

`/mcp` exposes the same capabilities as tools (`list_positions`, `scout_context`, `run_llm`, `list_changes`, …) so an agent can work the pipeline. [career-ops](https://a separate tracker) stays a separate project and reconciles its tracker two-way through these tools with a skill that lives on its side. See [docs/MCP.md](./docs/MCP.md).

## Deploy

One image, three entrypoints, a Helm chart at `deploy/helm/job-scout` (API Deployment, worker Deployment, three CronJobs). The browser plane is its own GitOps app.

## Observability

Prometheus metrics on `:9464/metrics` from both `api` and `worker` (`job_scout_*`: funnel, queue, LLM calls/tokens/latency per operation and model, jobs, scans, autopilot, chat, MCP, browser, plus Node runtime), JSON logs with stable event names, and a Grafana dashboard shipped by the chart. See [docs/OBSERVABILITY.md](./docs/OBSERVABILITY.md).

## Docs

[ARCHITECTURE](./docs/ARCHITECTURE.md) · [AI](./docs/AI.md) · [DATA-MODEL](./docs/DATA-MODEL.md) · [API](./docs/API.md) · [MCP](./docs/MCP.md) · [PRODUCT](./docs/PRODUCT.md) · [OBSERVABILITY](./docs/OBSERVABILITY.md)

## Upgrading existing data

Startup no longer runs historical data repairs. Use the [restored-database rehearsal and explicit repair command](docs/UPGRADING.md) before applying repairs. Keep personal data and deployment secrets in private runtime storage.
