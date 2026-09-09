# job-scout

**A personal career control plane.** It watches job boards, filters the noise deterministically, has a model triage and evaluate what is left, keeps an append-only history of every job description it has seen, drafts application materials, and gives you a chat agent that knows your pipeline and can drive a headless browser. It never applies on your behalf.

| | |
|--|--|
| **Stack** | TypeScript · Postgres (PGlite for dev/tests) · Hono API + embedded MCP · React 19 + Tailwind 4 · queue worker |
| **LLM** | any OpenAI-compatible `/v1` (`OPENAI_BASE_URL`, `OPENAI_API_KEY`). One model per operation, chosen in Settings › AI from the gateway's live `/v1/models` |
| **Browser** | optional dedicated [Steel Browser](https://github.com/steel-dev/steel-browser) + Playwright MCP (`apps/browser-job-scout`); render fallback for JS-only ATS pages and tools for the chat agent. Not the shared human Chrome at `the shared browser` |
| **Live** | `http://localhost:8080` · MCP at `/mcp` (Bearer) |

## How a listing flows

```text
board_scan ─► gate (title include/exclude · geo allow/block · posting age)
                │ reject ──► discovery_feed  (Radar › Filtered)
                └ pass ────► triage  1–5 + hard DQ ─► fail ──► discovery_feed
                                                    └ pass/marginal ─► positions  (status = triaged)
                                                              autopilot / you ─► evaluate  (A–H report)
                                                              autopilot / you ─► company_research
                                                              autopilot / you ─► materials  (resume + cover)
                                                              watch_check ────► jd_revisions  (+ jd_review on material change)
```

Everything the model does is one of six **operations** — `triage`, `evaluate`, `materials`, `company_research`, `jd_review`, `chat` — each with its own model, on/off switch, temperature and daily cap, and every call is logged to `llm_runs`. Boards are scanned and gated for free; the model only sees what passes.

**Sources.** Discovery scans Greenhouse, Ashby, and Lever company boards plus the Remote OK public JSON feed (`https://remoteok.com/api`) and the We Work Remotely DevOps/Sysadmin RSS (`https://weworkremotely.com/categories/remote-devops-sysadmin-jobs.rss`), craft-filtered with `isCraftMatch`. Remote OK `sys admin` / `infosec` tags keep only when the title is craft. Other market indexes stay manual watches. A Settings bookmarklet POSTs the current tab (`url`, `title`, `body.innerText`) so LinkedIn/Indeed JDs survive login walls — stay on the listing; it does not log in or apply for you.

## Autopilot

How much runs unattended is a policy (Settings › Autopilot). Three presets plus custom:

| preset | what runs by itself |
|--|--|
| **Manual** | scan and gate only; nothing calls a model until you click |
| **Assisted** (default) | triage every gated listing → evaluate when triage ≥ 4.0 → research the company on evaluate → re-review hot positions whose JD changed → file apply/skip *suggestions* in the Inbox |
| **Autopilot** | Assisted + evaluate every PASS + re-review any open JD + draft resume/cover above a score bar (drafts land in the Inbox) |

Pipeline status never changes without an approval. A global daily call/token budget sits above the per-operation caps. Details in [docs/AI.md](./docs/AI.md).

## UI

Dark/light. `⌘K` palette for positions, companies and actions. A right-hand dock with **Wire** (live worker activity), **Inbox** (approvals) and **Chat** (agent scoped to the page you are on: global, one position, one company).

| page | what it is for |
|--|--|
| **Today** | funnel, PASS verdicts to decide, approvals, JD changes, interviews, follow-ups, model usage and budget |
| **Pipeline** | every position as a table (`j`/`k`/`Enter`/`o`) or a board; filters on status, verdict, score, geo, listing status |
| **Radar** | what the scanners saw: discovery lanes, board deltas, sources, watches |
| **Companies** | grid or table, with research and positions per company |
| **Inbox** | autopilot suggestions and drafts to approve or dismiss |
| **Position** | status stepper · Brief · Evaluation · JD (revisions + diffs) · Materials · Company · History |
| **Settings** | Profile · Gate · AI models · Autopilot · Appearance · System (queue, retention, tokens, job-scout Steel health) |

## Quickstart

```bash
cp .env.example .env         # leave DATABASE_URL unset for embedded PGlite
pnpm install
pnpm dev                     # API + UI (Vite) + embedded worker on http://localhost:8080
pnpm test                    # vitest on PGlite
```

Point it at a gateway with `OPENAI_BASE_URL` / `OPENAI_API_KEY`, then pick models under Settings › AI. Default agent/MCP token: `dev-agent-token` (`API_TOKEN_SEED`).

Separate processes, as deployed:

```bash
pnpm dev:api                 # apps/api    — Hono, MCP, serves apps/web/dist in prod
pnpm dev:worker              # apps/worker — queue consumer + in-process scheduler
pnpm once discovery|watch|retention   # one-shot entrypoints used by the CronJobs
pnpm db:generate             # drizzle-kit: new migration from schema.ts
```

## Layout

```text
apps/api/          Hono routes by resource · auth · mcp/ (29 tools) · serves the web bundle
apps/worker/       loop.ts (job types, retries, stale requeue) · once.ts (cron entry)
apps/web/          React app — ui/kit.tsx primitives · frame/ (sidebar, dock, chat, palette) · pages/
packages/core/     services shared by api + worker: positions, scan, triage, evaluate, materials,
                   autopilot, chat, browser, settings, retention, radar
packages/llm/      OpenAI-compatible client (json_schema, document, streaming tool calls) · prompts · scout brief
packages/db/       drizzle schema + migrations · Postgres or PGlite client
packages/shared/   gate · settings schema · classify · salary · hash · types
packages/ats/      Greenhouse / Ashby / Lever / Remote OK JSON / generic HTML fetchers, optional browser renderer
packages/desk-ui/  vendored @desk-ui/api-client (fetch envelope + React Query hooks)
deploy/            Dockerfile · compose · helm/job-scout (chart + dashboards/job-scout.json)
scripts/           one-off importers (previous-generation database → current schema), model benchmark (`pnpm bench:models`, results in docs/benchmarks/)
docs/              ARCHITECTURE · AI · DATA-MODEL · API · MCP · PRODUCT · DEPLOY · OBSERVABILITY
```

## MCP and career-ops

`/mcp` exposes the same capabilities as tools (`list_positions`, `scout_context`, `run_llm`, `list_changes`, …) so an agent can work the pipeline. [career-ops](https://a separate tracker) stays a separate project and reconciles its tracker two-way through these tools with a skill that lives on its side. See [docs/MCP.md](./docs/MCP.md).

## Deploy

One image, three entrypoints, a Helm chart with an API Deployment, a worker Deployment and three CronJobs. The browser plane is its own GitOps app. See [docs/DEPLOY.md](./docs/DEPLOY.md).

## Observability

Prometheus metrics on `:9464/metrics` from both `api` and `worker` (`job_scout_*`: funnel, queue, LLM calls/tokens/latency per operation and model, jobs, scans, autopilot, chat, MCP, browser, plus Node runtime), JSON logs with stable event names, and a Grafana dashboard shipped by the chart. See [docs/OBSERVABILITY.md](./docs/OBSERVABILITY.md).

## Docs

[ARCHITECTURE](./docs/ARCHITECTURE.md) · [AI](./docs/AI.md) · [DATA-MODEL](./docs/DATA-MODEL.md) · [API](./docs/API.md) · [MCP](./docs/MCP.md) · [PRODUCT](./docs/PRODUCT.md) · [DEPLOY](./docs/DEPLOY.md) · [OBSERVABILITY](./docs/OBSERVABILITY.md)
