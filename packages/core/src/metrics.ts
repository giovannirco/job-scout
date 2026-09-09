/**
 * Prometheus metrics. One registry per process; `initMetrics()` stamps the component label and
 * enables Node default metrics. Counters/histograms are incremented in-line by the modules that
 * own the work (llm, worker loop, scan, chat, browser…). DB-truth gauges (queue depth, funnel,
 * approvals…) are refreshed on scrape by the process that calls `enableDbGauges()` — the API only,
 * so a single replica reports them and sums stay honest.
 *
 * Exposed by `startMetricsServer()` on METRICS_PORT (default 9464) at /metrics, off the HTTPRoute.
 */
import { createServer, type Server } from "node:http";
import client from "prom-client";
import { sql } from "drizzle-orm";
import { getDb, poolStats } from "@job-scout/db";
import { log as rootLog } from "@job-scout/shared";

const log = rootLog.child({ scope: "metrics" });
const P = "job_scout_";

export const registry = new client.Registry();

export const ingestQuality = new client.Counter({
  name: `${P}ingest_quality_total`,
  help: "Rejected or repaired ingest records by reason.",
  labelNames: ["reason"],
  registers: [registry],
});

let initialized = false;
export function initMetrics(component: "api" | "worker" | "once", version: string) {
  if (initialized) return;
  initialized = true;
  registry.setDefaultLabels({ component });
  client.collectDefaultMetrics({ register: registry, prefix: "" });
  buildInfo.labels({ version }).set(1);
}

// ---------------------------------------------------------------------------------------------
// counters & histograms (process-local truth)
// ---------------------------------------------------------------------------------------------

export const buildInfo = new client.Gauge({
  name: `${P}build_info`,
  help: "Always 1; carries the running version.",
  labelNames: ["version"],
  registers: [registry],
});

export const httpRequests = new client.Counter({
  name: `${P}http_requests_total`,
  help: "API requests by matched route and status.",
  labelNames: ["method", "route", "status"],
  registers: [registry],
});
export const httpDuration = new client.Histogram({
  name: `${P}http_request_duration_seconds`,
  help: "API request latency by matched route.",
  labelNames: ["method", "route"],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  registers: [registry],
});

export const llmCalls = new client.Counter({
  name: `${P}llm_calls_total`,
  help: "LLM calls through an OpenAI-compatible gateway by operation, model and outcome.",
  labelNames: ["operation", "model", "status"],
  registers: [registry],
});
export const llmTokens = new client.Counter({
  name: `${P}llm_tokens_total`,
  help: "Prompt (in) and completion (out) tokens.",
  labelNames: ["operation", "model", "direction"],
  registers: [registry],
});
export const llmLatency = new client.Histogram({
  name: `${P}llm_latency_seconds`,
  help: "LLM call wall time.",
  labelNames: ["operation", "model"],
  buckets: [1, 2, 5, 10, 20, 30, 60, 90, 120, 180, 300],
  registers: [registry],
});
export const llmGate = new client.Counter({
  name: `${P}llm_gate_total`,
  help: "Calls refused before reaching the model (disabled, no_model, cap_reached, budget_reached, not_configured).",
  labelNames: ["operation", "code"],
  registers: [registry],
});

export const jobsProcessed = new client.Counter({
  name: `${P}jobs_processed_total`,
  help: "Worker jobs finished by type and outcome (ok, failed, retry, parked).",
  labelNames: ["type", "outcome"],
  registers: [registry],
});
export const jobDuration = new client.Histogram({
  name: `${P}job_duration_seconds`,
  help: "Worker job wall time by type.",
  labelNames: ["type"],
  buckets: [0.1, 0.5, 1, 2, 5, 10, 20, 30, 60, 120, 300, 600],
  registers: [registry],
});
export const jobsInFlight = new client.Gauge({
  name: `${P}jobs_in_flight`,
  help: "Jobs currently running in this worker.",
  registers: [registry],
});
export const schedulerRuns = new client.Counter({
  name: `${P}scheduler_runs_total`,
  help: "Scheduler ticks (discovery, watch, retention, requeue-stale) by outcome.",
  labelNames: ["task", "status"],
  registers: [registry],
});

export const boardScans = new client.Counter({
  name: `${P}board_scans_total`,
  help: "Board scans by ATS provider and outcome.",
  labelNames: ["provider", "status"],
  registers: [registry],
});
export const scanListings = new client.Counter({
  name: `${P}scan_listings_total`,
  help: "Listings seen during board scans: seen, gate_pass, gate_fail, created, updated, closed.",
  labelNames: ["provider", "outcome"],
  registers: [registry],
});
export const jdChanges = new client.Counter({
  name: `${P}jd_changes_total`,
  help: "JD revisions written, by change kind and materiality.",
  labelNames: ["change_kind", "material"],
  registers: [registry],
});
export const watchChecks = new client.Counter({
  name: `${P}watch_checks_total`,
  help: "Watch checks by outcome (unchanged, changed, closed, error).",
  labelNames: ["outcome"],
  registers: [registry],
});

export const autopilotActions = new client.Counter({
  name: `${P}autopilot_actions_total`,
  help: "What the autopilot did after each hook: enqueue_<job>, approval_<kind>, archive, skip.",
  labelNames: ["hook", "action"],
  registers: [registry],
});
export const approvalsResolved = new client.Counter({
  name: `${P}approvals_resolved_total`,
  help: "Inbox items resolved by kind and decision.",
  labelNames: ["kind", "decision"],
  registers: [registry],
});

export const chatTurns = new client.Counter({
  name: `${P}chat_turns_total`,
  help: "Chat agent turns by scope and outcome.",
  labelNames: ["scope", "status"],
  registers: [registry],
});
export const chatToolCalls = new client.Counter({
  name: `${P}chat_tool_calls_total`,
  help: "Tools the chat agent invoked.",
  labelNames: ["tool", "ok"],
  registers: [registry],
});
export const chatTurnDuration = new client.Histogram({
  name: `${P}chat_turn_seconds`,
  help: "Wall time of one chat turn (all tool rounds).",
  labelNames: ["scope"],
  buckets: [1, 2, 5, 10, 20, 30, 60, 120, 300],
  registers: [registry],
});

export const browserRenders = new client.Counter({
  name: `${P}browser_renders_total`,
  help: "Page renders by path (steel, http) and outcome.",
  labelNames: ["via", "ok"],
  registers: [registry],
});
export const browserRenderDuration = new client.Histogram({
  name: `${P}browser_render_seconds`,
  help: "Steel render wall time.",
  buckets: [0.5, 1, 2, 5, 10, 20, 30, 60],
  registers: [registry],
});

export const retentionDeleted = new client.Counter({
  name: `${P}retention_deleted_rows_total`,
  help: "Rows pruned by retention, by table.",
  labelNames: ["table"],
  registers: [registry],
});

export const mcpCalls = new client.Counter({
  name: `${P}mcp_tool_calls_total`,
  help: "MCP tool invocations by tool and outcome.",
  labelNames: ["tool", "status"],
  registers: [registry],
});
export const mcpDuration = new client.Histogram({
  name: `${P}mcp_tool_duration_seconds`,
  help: "MCP tool wall time.",
  labelNames: ["tool"],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120],
  registers: [registry],
});

// ---------------------------------------------------------------------------------------------
// DB-truth gauges (refreshed on scrape, API only)
// ---------------------------------------------------------------------------------------------

const g = (name: string, help: string, labelNames: string[] = []) =>
  new client.Gauge({ name: `${P}${name}`, help, labelNames, registers: [registry] });

const dbGauges = {
  queueJobs: g("queue_jobs", "Jobs in the queue table by type and status.", ["type", "status"]),
  queueOldestAge: g("queue_oldest_queued_age_seconds", "Age of the oldest queued job that is due."),
  positions: g("positions", "Positions by pipeline status.", ["status"]),
  positionsVerdict: g("positions_by_verdict", "Non-archived positions by triage verdict (untriaged when null).", ["verdict"]),
  positionsListing: g("positions_by_listing_status", "Non-archived positions by listing status (open, closed, unknown).", ["listing_status"]),
  approvalsPending: g("approvals_pending", "Autopilot inbox items waiting for the operator.", ["kind"]),
  companies: g("companies_total", "Companies known."),
  companiesResearched: g("companies_researched", "Companies with a research dossier."),
  boards: g("board_sources", "Board sources by provider and enabled flag.", ["provider", "enabled"]),
  boardsErrored: g("board_sources_errored", "Enabled boards whose last scan failed."),
  boardsStale: g("board_sources_stale", "Enabled boards not scanned for > 2 days."),
  watches: g("watches", "Watch rows by enabled flag.", ["enabled"]),
  discovery24h: g("discovery_listings_24h", "Discovery rows observed in the last 24h by lane.", ["lane"]),
  jdRevisions24h: g("jd_revisions_24h", "JD revisions written in the last 24h by change kind.", ["change_kind"]),
  llmCallsToday: g("llm_calls_today", "LLM runs today (UTC) by operation and status.", ["operation", "status"]),
  llmTokensToday: g("llm_tokens_today", "LLM tokens today (UTC) by operation.", ["operation"]),
  llmBudgetCalls: g("llm_budget_daily_calls", "Configured daily call budget (0 = unlimited)."),
  llmBudgetTokens: g("llm_budget_daily_tokens", "Configured daily token budget (0 = unlimited)."),
  chatThreads: g("chat_threads", "Chat threads by scope.", ["scope"]),
  evaluations: g("evaluations_total", "Evaluations stored."),
  materials: g("materials_total", "Material documents stored."),
  interviewsUpcoming: g("interviews_upcoming", "Positions with a next interview in the future."),
  dbPool: g("db_pool_connections", "pg pool connections by state.", ["state"]),
  scrapeDuration: g("metrics_db_refresh_seconds", "How long the DB gauge refresh took."),
  scrapeErrors: g("metrics_db_refresh_errors", "1 if the last DB gauge refresh failed."),
};

let dbGaugesEnabled = false;
let lastRefresh = 0;
let refreshing: Promise<void> | null = null;
const REFRESH_TTL_MS = 10_000;

/** Turn on DB-truth gauges in this process (call from the API only). */
export function enableDbGauges() {
  dbGaugesEnabled = true;
}

type Row = Record<string, unknown>;
const rows = async (q: ReturnType<typeof sql>): Promise<Row[]> => {
  const db = await getDb();
  const res = (await db.execute(q)) as unknown as { rows?: Row[] } | Row[];
  return Array.isArray(res) ? res : (res.rows ?? []);
};
const num = (v: unknown) => Number(v ?? 0);

async function refreshDbGauges() {
  const t0 = Date.now();
  try {
    const [queue, oldest, pos, verdict, listing, appr, comp, boards, watches, disc, jd, llm, budget, chat, misc] = await Promise.all([
      rows(sql`select type, status, count(*)::int as c from jobs group by 1,2`),
      rows(sql`select coalesce(extract(epoch from now() - min(run_after)), 0)::float as age from jobs where status = 'queued' and run_after <= now()`),
      rows(sql`select status, count(*)::int as c from positions group by 1`),
      rows(sql`select coalesce(triage_verdict, 'untriaged') as v, count(*)::int as c from positions where status <> 'archived' group by 1`),
      rows(sql`select coalesce(listing_status, 'unknown') as s, count(*)::int as c from positions where status <> 'archived' group by 1`),
      rows(sql`select kind, count(*)::int as c from approvals where status = 'pending' group by 1`),
      rows(sql`select count(*)::int as total, (select count(distinct company_id) from evaluations where kind = 'company_research')::int as researched from companies`),
      rows(sql`select provider, enabled, count(*)::int as c,
                 count(*) filter (where enabled and last_error is not null)::int as errored,
                 count(*) filter (where enabled and (last_scanned_at is null or last_scanned_at < now() - interval '2 days'))::int as stale
               from board_sources group by 1,2`),
      rows(sql`select enabled, count(*)::int as c from watches group by 1`),
      rows(sql`select lane, count(*)::int as c from discovery_feed where observed_at > now() - interval '24 hours' group by 1`),
      rows(sql`select change_kind, count(*)::int as c from jd_revisions where observed_at > now() - interval '24 hours' group by 1`),
      rows(sql`select operation, status, count(*)::int as c, coalesce(sum(coalesce(tokens_in,0) + coalesce(tokens_out,0)),0)::bigint as tokens
               from llm_runs where created_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc' group by 1,2`),
      rows(sql`select coalesce((data->'autopilot'->'budget'->>'dailyCalls')::int, 0) as calls,
                      coalesce((data->'autopilot'->'budget'->>'dailyTokens')::int, 0) as tokens
               from settings where id = 'default'`),
      rows(sql`select scope, count(*)::int as c from chat_threads group by 1`),
      rows(sql`select (select count(*) from evaluations)::int as evals,
                      (select count(*) from application_materials)::int as mats,
                      (select count(*) from interviews where scheduled_at > now() and status <> 'cancelled')::int as interviews`),
    ]);

    dbGauges.queueJobs.reset();
    for (const r of queue) dbGauges.queueJobs.labels({ type: String(r.type), status: String(r.status) }).set(num(r.c));
    dbGauges.queueOldestAge.set(num(oldest[0]?.age));

    dbGauges.positions.reset();
    for (const r of pos) dbGauges.positions.labels({ status: String(r.status) }).set(num(r.c));
    dbGauges.positionsVerdict.reset();
    for (const r of verdict) dbGauges.positionsVerdict.labels({ verdict: String(r.v) }).set(num(r.c));
    dbGauges.positionsListing.reset();
    for (const r of listing) dbGauges.positionsListing.labels({ listing_status: String(r.s) }).set(num(r.c));

    dbGauges.approvalsPending.reset();
    for (const r of appr) dbGauges.approvalsPending.labels({ kind: String(r.kind) }).set(num(r.c));

    dbGauges.companies.set(num(comp[0]?.total));
    dbGauges.companiesResearched.set(num(comp[0]?.researched));

    dbGauges.boards.reset();
    let errored = 0;
    let stale = 0;
    for (const r of boards) {
      dbGauges.boards.labels({ provider: String(r.provider), enabled: String(r.enabled) }).set(num(r.c));
      errored += num(r.errored);
      stale += num(r.stale);
    }
    dbGauges.boardsErrored.set(errored);
    dbGauges.boardsStale.set(stale);

    dbGauges.watches.reset();
    for (const r of watches) dbGauges.watches.labels({ enabled: String(r.enabled) }).set(num(r.c));

    dbGauges.discovery24h.reset();
    for (const r of disc) dbGauges.discovery24h.labels({ lane: String(r.lane) }).set(num(r.c));
    dbGauges.jdRevisions24h.reset();
    for (const r of jd) dbGauges.jdRevisions24h.labels({ change_kind: String(r.change_kind) }).set(num(r.c));

    dbGauges.llmCallsToday.reset();
    dbGauges.llmTokensToday.reset();
    const tokensByOp = new Map<string, number>();
    for (const r of llm) {
      dbGauges.llmCallsToday.labels({ operation: String(r.operation), status: String(r.status) }).set(num(r.c));
      tokensByOp.set(String(r.operation), (tokensByOp.get(String(r.operation)) ?? 0) + num(r.tokens));
    }
    for (const [op, t] of tokensByOp) dbGauges.llmTokensToday.labels({ operation: op }).set(t);
    dbGauges.llmBudgetCalls.set(num(budget[0]?.calls));
    dbGauges.llmBudgetTokens.set(num(budget[0]?.tokens));

    dbGauges.chatThreads.reset();
    for (const r of chat) dbGauges.chatThreads.labels({ scope: String(r.scope) }).set(num(r.c));

    dbGauges.evaluations.set(num(misc[0]?.evals));
    dbGauges.materials.set(num(misc[0]?.mats));
    dbGauges.interviewsUpcoming.set(num(misc[0]?.interviews));

    dbGauges.scrapeErrors.set(0);
  } catch (e) {
    dbGauges.scrapeErrors.set(1);
    log.warn("metrics.db_refresh.failed", { err: e });
  } finally {
    dbGauges.scrapeDuration.set((Date.now() - t0) / 1000);
    lastRefresh = Date.now();
  }
}

function refreshPool() {
  const s = poolStats();
  dbGauges.dbPool.labels({ state: "total" }).set(s.total);
  dbGauges.dbPool.labels({ state: "idle" }).set(s.idle);
  dbGauges.dbPool.labels({ state: "waiting" }).set(s.waiting);
}

/** Render the registry; refreshes DB gauges (throttled) when enabled. */
export async function renderMetrics(): Promise<string> {
  refreshPool();
  if (dbGaugesEnabled && Date.now() - lastRefresh > REFRESH_TTL_MS) {
    refreshing ??= refreshDbGauges().finally(() => (refreshing = null));
    await refreshing;
  }
  return registry.metrics();
}

/** Tiny HTTP server for /metrics (and /healthz) on its own port so it never rides the HTTPRoute. */
export function startMetricsServer(port = Number(process.env.METRICS_PORT ?? 9464), host = "0.0.0.0"): Server | null {
  if (!port) return null;
  const server = createServer(async (req, res) => {
    const url = req.url?.split("?")[0] ?? "/";
    if (url === "/metrics") {
      try {
        const body = await renderMetrics();
        res.writeHead(200, { "content-type": registry.contentType });
        res.end(body);
      } catch (e) {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end(e instanceof Error ? e.message : String(e));
      }
      return;
    }
    if (url === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(port, host, () => log.info("metrics.listening", { port, path: "/metrics" }));
  server.on("error", (err) => log.error("metrics.server.error", { err, port }));
  return server;
}

/** Route pattern for HTTP metrics: collapse ids so cardinality stays bounded. */
export function metricRoute(routePath: string | undefined, path: string): string {
  if (routePath && !routePath.endsWith("*")) return routePath;
  return path
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "/:id")
    .replace(/\/(pos|co|job|run|appr|thr|mat|eval|tok|rev)_[A-Za-z0-9_-]+/g, "/:id")
    .replace(/\/\d+(?=\/|$)/g, "/:n")
    .slice(0, 80);
}
