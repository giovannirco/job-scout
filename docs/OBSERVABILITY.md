# Observability

Three signals, all picked up by the cluster's Grafana k8s-monitoring stack (Alloy → Mimir / Loki) with no extra wiring beyond pod annotations.

| Signal | Where it comes from | How it gets out |
|---|---|---|
| Metrics | `prom-client` registry in `packages/core/src/metrics.ts`, served on `:9464/metrics` by both `api` and `worker` | Alloy pod autodiscovery via `k8s.grafana.com/*` annotations (Helm sets them) → Mimir, job `job-scout` |
| Logs | One JSON object per line on stdout/stderr (`packages/shared/src/log.ts`) | Alloy tails every container in the namespace → Loki; query with `{namespace="job-scout"} \| json` |
| Request traces / RED at the edge | Beyla (cluster-wide eBPF) and Envoy access logs | Already there; the dashboard reads `http_server_request_duration_seconds{namespace="job-scout"}` |

The dashboard lives in the repo at `deploy/helm/job-scout/dashboards/job-scout.json` and is shipped by the chart as a `grafana_dashboard=1` ConfigMap (folder **job-scout**, uid `job-scout`).

## Metrics

### Endpoint

- `GET :9464/metrics` on `api` and `worker`. The port is separate from the app port so it never rides the HTTPRoute; `METRICS_PORT=0` disables it. `GET :9464/healthz` answers `ok`.
- Every series carries `component="api"|"worker"`. Node default metrics (`process_*`, `nodejs_*`) are on too.
- CronJob pods (`once.ts`) are short-lived and do not serve metrics; their effect shows up in the DB-truth gauges below and in `kube_job_*` / `kube_cronjob_*`.

### Two kinds of series

**Process counters and histograms** are incremented in-line by the code that does the work. They reset on restart, so use `rate()` / `increase()`.

| Metric | Labels | Meaning |
|---|---|---|
| `job_scout_build_info` | `version` | Always 1 |
| `job_scout_http_requests_total` | `method route status` | API requests by matched Hono route (`/api/v1/positions/:id`) |
| `job_scout_http_request_duration_seconds` | `method route` | API latency histogram |
| `job_scout_llm_calls_total` | `operation model status` | Calls to an OpenAI-compatible gateway (`ok` / `error`) |
| `job_scout_llm_tokens_total` | `operation model direction` | Prompt (`in`) and completion (`out`) tokens |
| `job_scout_llm_latency_seconds` | `operation model` | Wall time per call |
| `job_scout_llm_gate_total` | `operation code` | Refused before the model: `disabled` `no_model` `cap_reached` `budget_reached` `not_configured` |
| `job_scout_jobs_processed_total` | `type outcome` | Worker jobs: `ok` `failed` `retry` `parked` |
| `job_scout_job_duration_seconds` | `type` | Job wall time |
| `job_scout_jobs_in_flight` | | Running in this worker |
| `job_scout_scheduler_runs_total` | `task status` | In-process ticks (`requeue-stale` always; others only with `WORKER_SCHEDULER=1`) |
| `job_scout_board_scans_total` | `provider status` | Board scans |
| `job_scout_scan_listings_total` | `provider outcome` | `seen` `gate_pass` `gate_fail` `created` `updated` `closed` |
| `job_scout_ingest_quality_total` | `reason` | Ingest rejected or repaired (`placeholder_url`, `unresolved_company`, `junk_title`, `triage_zero_score`) |
| `job_scout_jd_changes_total` | `change_kind material` | JD revisions written |
| `job_scout_watch_checks_total` | `outcome` | `unchanged` `changed` `closed` `first_seen` |
| `job_scout_autopilot_actions_total` | `hook action` | `enqueue_evaluate`, `enqueue_company_research`, `enqueue_materials`, `enqueue_jd_review`, `approval`, `noop` |
| `job_scout_approvals_resolved_total` | `kind decision` | Inbox decisions |
| `job_scout_chat_turns_total` | `scope status` | Chat agent turns (`ok` `error` `aborted`) |
| `job_scout_chat_tool_calls_total` | `tool ok` | Tools the agent used (local + browser MCP) |
| `job_scout_chat_turn_seconds` | `scope` | Whole-turn latency |
| `job_scout_browser_renders_total` | `via ok` | Steel renders and plain-HTTP fallbacks |
| `job_scout_browser_render_seconds` | | Steel render latency |
| `job_scout_mcp_tool_calls_total` | `tool status` | MCP tool invocations (`ok` `error` `throw`) |
| `job_scout_mcp_tool_duration_seconds` | `tool` | MCP tool latency |
| `job_scout_retention_deleted_rows_total` | `table` | Rows pruned |
| `job_scout_notify_enqueued_total` | `channel event` | WhatsApp outbox rows inserted |
| `job_scout_notify_sent_total` | `channel event outcome` | Flush attempts (`sent` `failed` `noop`) |
| `job_scout_notify_inbox_total` | `outcome` | Inbound desk-chat turns (`ok` `turn_error` `fetch_error`) |

**DB-truth gauges** are refreshed on scrape (throttled to once per 10 s) by the **API only**, so a single replica reports them and sums stay honest. They survive restarts because they are read from Postgres.

| Metric | Labels | Meaning |
|---|---|---|
| `job_scout_queue_jobs` | `type status` | Rows in `jobs` |
| `job_scout_queue_oldest_queued_age_seconds` | | Oldest due job still waiting — the "is the worker alive" signal |
| `job_scout_positions` | `status` | Funnel |
| `job_scout_positions_by_verdict` | `verdict` | Non-archived; `untriaged` when the LLM has not scored yet |
| `job_scout_positions_by_listing_status` | `listing_status` | `open` `changed` `closed` |
| `job_scout_approvals_pending` | `kind` | Inbox |
| `job_scout_companies_total`, `job_scout_companies_researched` | | |
| `job_scout_board_sources` | `provider enabled` | |
| `job_scout_board_sources_errored`, `job_scout_board_sources_stale` | | Enabled boards with a failed last scan / not scanned for 2 days |
| `job_scout_watches` | `enabled` | |
| `job_scout_discovery_listings_24h` | `lane` | |
| `job_scout_jd_revisions_24h` | `change_kind` | |
| `job_scout_llm_calls_today`, `job_scout_llm_tokens_today` | `operation (status)` | UTC day, from `llm_runs` |
| `job_scout_llm_budget_daily_calls`, `job_scout_llm_budget_daily_tokens` | | From Settings → Autopilot (0 = unlimited) |
| `job_scout_chat_threads` | `scope` | |
| `job_scout_evaluations_total`, `job_scout_materials_total`, `job_scout_interviews_upcoming` | | |
| `job_scout_db_pool_connections` | `state` | pg pool `total` `idle` `waiting` |
| `job_scout_metrics_db_refresh_seconds`, `job_scout_metrics_db_refresh_errors` | | Cost / health of the gauge refresh itself |

### Adding a metric

Declare it in `packages/core/src/metrics.ts` (all names are prefixed `job_scout_`, labels are low-cardinality enums — never ids or URLs), import it where the work happens, then add a panel to the dashboard. `pnpm dev` + `curl :9464/metrics` shows it immediately.

## Logs

`packages/shared/src/log.ts` — zero-dependency structured logger.

- `LOG_FORMAT=json` (default when `NODE_ENV=production`) writes one object per line; anything else prints a compact coloured line for `pnpm dev`.
- `LOG_LEVEL=debug|info|warn|error` (default `info`). `warn`/`error` go to stderr.
- Each process calls `setLogContext({ component, version })` at boot; modules use `log.child({ scope })`.

Shape:

```json
{"ts":"2026-09-03T21:28:32.626Z","level":"info","component":"worker","version":"2.8.4","scope":"worker",
 "msg":"job.ok","jobId":"job_YNy_9tr9vrwt","type":"triage","attempt":1,"positionId":"pos_bk_o9LPC1cTL","ms":1779,"verdict":"fail","score":2.8}
```

`msg` is a stable dotted event name, never free text. Events you will grep for:

| Event | Emitted by |
|---|---|
| `http.request` | every `/api/*` and `/mcp` request (method, route, status, ms, requestId, user) — health/ready/metrics are logged only on ≥ 400 |
| `http.unhandled` | Hono `onError` |
| `mcp.tool` | every MCP tool call (tool, status, ms, compact args) |
| `job.ok` / `job.failed` | worker loop (type, ms, outcome, gate code, error) |
| `scheduler.ok` / `scheduler.failed` | in-process ticks |
| `llm.call` / `llm.call.failed` | each model call (operation, model, tokens, ms) |
| `scan.board.done` / `scan.board.failed` / `scan.listing.failed` | board scans |
| `jd.revision` | a JD revision was written (changeKind, material, closed, fields) |
| `autopilot.hook` / `autopilot.hook.failed` | what each hook decided (`actions`) |
| `approval.resolved` | inbox decision |
| `chat.turn` / `chat.turn.failed` / `chat.tool` | chat agent |
| `waha.noop` | sender constructed without `WAHA_BASE_URL`/`WAHA_API_KEY` |
| `notify.emit.failed` / `notify.send.failed` | outbox insert / WAHA sendText |
| `whatsapp.inbox.webhook_failed` / `whatsapp.inbox.fetch_failed` / `whatsapp.inbox.turn_failed` | inbound desk chat |
| `browser.render` / `browser.render.failed` | Steel |
| `retention.done`, `once.done` / `once.failed` | cron entry |
| `db.pool.error`, `db.migrations.applied` | Postgres |
| `api.listening`, `worker.start`, `worker.shutdown`, `metrics.listening`, `*.fatal` | lifecycle |

Errors are serialised as `error`, `errorName`, `stack` (first 8 frames), `cause`.

Useful LogQL:

```logql
{namespace="job-scout"} | json | level=~"warn|error"
{namespace="job-scout"} | json | msg="llm.call" | operation="evaluate" | ms > 60000
{namespace="job-scout"} | json | msg="http.request" | status >= 500
{namespace="job-scout", container="worker"} | json | msg="job.failed" | line_format "{{.type}} {{.error}}"
sum by (level) (count_over_time({namespace="job-scout"} | json [5m]))
```

The two `Debugger listening on ws://127.0.0.1:9229` lines at pod start are not from the app: Grafana Beyla attaches to Node processes through the inspector to read runtime metadata.

## Alloy

Nothing job-scout-specific is configured in Alloy. It already:

- tails stdout of every pod (`alloy-logs` DaemonSet) — `sum by (container) (count_over_time({namespace="job-scout"}[1h]))` shows `api`, `worker`, `discovery`, `watch`, `retention`;
- scrapes pods that carry the `k8s.grafana.com/scrape: "true"` annotation (`alloy-metrics`), using `metrics_portNumber`, `metrics_path`, `metrics_scrapeInterval` and `job` from the sibling annotations.

The Helm chart adds those annotations to the `api` and `worker` pod templates when `metrics.enabled=true` (default). Verify from anywhere on the LAN:

```bash
curl -sG http://127.0.0.1:9009/prometheus/api/v1/query --data-urlencode 'query=up{job="job-scout"}'
curl -sG http://127.0.0.1:9009/prometheus/api/v1/query --data-urlencode 'query=job_scout_build_info'
```

## Dashboard

`deploy/helm/job-scout/dashboards/job-scout.json` — uid `job-scout`, seven rows:

1. **Overview** — version, hot pipeline, untriaged, inbox, queue depth, oldest queued age, boards errored/stale, LLM calls/tokens/budget today, errors in the last hour.
2. **Pipeline** — funnel, positions by status over time, verdicts, discovery lanes, JD revisions, listing status, inventory table.
3. **LLM (an OpenAI-compatible gateway)** — calls/min and tokens/min by operation, p50/p95 latency, errors and gate refusals, today by operation/model.
4. **Worker and queue** — jobs/min by type, outcomes, p95 duration, queue by status, scheduler ticks, scan outcomes, board scans, watch checks/JD changes, autopilot actions, approvals, retention.
5. **API, MCP, chat, browser** — req/s and p95 by route, error rates, MCP tools, chat turns/tools, Steel renders, Beyla edge RED.
6. **Runtime and Kubernetes** — CPU/memory vs limits, restarts, Node heap/RSS, event-loop lag, GC, pg pool, CronJob freshness and failures, pods by phase.
7. **Logs** — volume by level and component, warnings/errors, LLM calls, jobs/autopilot (all `| json`).

Variables: `datasource` (Prometheus, default Mimir), `loki`, `job` (scrape job, `job-scout`), `namespace`. A "Deploys" annotation marks `job_scout_build_info` version changes.

The chart renders it into a ConfigMap labelled `grafana_dashboard: "1"` with `grafana_folder: job-scout`; the Grafana sidecar loads it within a minute of sync. Edit the JSON in the repo (Grafana → Share → Export → paste back), not in the UI — the sidecar overwrites UI edits on the next sync.
