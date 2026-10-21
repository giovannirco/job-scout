import { and, desc, eq, sql } from "drizzle-orm";
import { getDb, jobs, notificationOutbox } from "@job-scout/db";
import {
  assessLlmHealth,
  describeLlmFailure,
  LLM_ALERT_COOLDOWN_MS,
  LLM_OPERATION_IDS,
  LLM_PROBE_INTERVAL_MS,
  LLM_HEALTH_DEFAULTS,
  llmHealthStateValue,
  type LlmHealthReport,
  type LlmRunSample,
  log as rootLog,
} from "@job-scout/shared";
import { llmConfigured } from "./llm.js";
import { llmConsecutiveFailures, llmFailureRatio, llmHealthStatus, llmProviderDown } from "./metrics.js";

const log = rootLog.child({ scope: "llm-health" });
const CACHE_MS = 10_000;
/** Look back far enough that a long outage with sparse probes still shows its streak. */
const LOOKBACK_MS = 24 * 3_600_000;

let cache: { at: number; value: LlmHealthReport } | null = null;
let pending: Promise<LlmHealthReport> | null = null;

export function invalidateLlmHealth() {
  cache = null;
}

type Row = Record<string, unknown>;

async function recentRuns(): Promise<LlmRunSample[]> {
  const db = await getDb();
  const since = new Date(Date.now() - LOOKBACK_MS);
  const res = (await db.execute(sql`
    select operation, status, error, latency_ms, tokens_in, tokens_out, created_at from (
      select operation, status, error, latency_ms, tokens_in, tokens_out, created_at,
             row_number() over (partition by operation order by created_at desc, id desc) as rn
      from llm_runs
      where created_at >= ${since} and operation <> 'test'
    ) t where rn <= ${LLM_HEALTH_DEFAULTS.sample}
  `)) as unknown as { rows?: Row[] } | Row[];
  const rows = Array.isArray(res) ? res : (res.rows ?? []);
  return rows.map((r) => ({
    operation: String(r.operation),
    status: String(r.status),
    error: (r.error as string | null) ?? null,
    latencyMs: r.latency_ms == null ? null : Number(r.latency_ms),
    tokensIn: r.tokens_in == null ? null : Number(r.tokens_in),
    tokensOut: r.tokens_out == null ? null : Number(r.tokens_out),
    createdAt: new Date(r.created_at as string),
  }));
}

/** Health over recent llm_runs. Cached briefly; both API and worker read the same table. */
export async function getLlmHealth(opts: { fresh?: boolean } = {}): Promise<LlmHealthReport & { configured: boolean }> {
  if (!opts.fresh && cache && Date.now() - cache.at < CACHE_MS) return { ...cache.value, configured: llmConfigured() };
  pending ??= recentRuns()
    .then((runs) => {
      const value = assessLlmHealth(runs, { operations: LLM_OPERATION_IDS });
      cache = { at: Date.now(), value };
      setLlmHealthGauges(value);
      return value;
    })
    .finally(() => (pending = null));
  return { ...(await pending), configured: llmConfigured() };
}

export function setLlmHealthGauges(report: LlmHealthReport) {
  llmHealthStatus.reset();
  llmConsecutiveFailures.reset();
  llmFailureRatio.reset();
  llmProviderDown.reset();
  for (const op of report.operations) {
    llmHealthStatus.labels({ operation: op.operation }).set(llmHealthStateValue(op.state));
    llmConsecutiveFailures.labels({ operation: op.operation }).set(op.consecutiveFailures);
    llmFailureRatio.labels({ operation: op.operation }).set(op.failureRatio);
  }
  llmProviderDown.labels({ kind: report.providerDown ? (report.kind ?? "outage") : "none" }).set(report.providerDown ? 1 : 0);
}

/** Public projection for /api/v1/health: states and counts, never error text. */
export function publicLlmHealth(report: LlmHealthReport & { configured: boolean }) {
  return {
    configured: report.configured,
    state: report.state,
    providerDown: report.providerDown,
    kind: report.kind,
    failingSince: report.failingSince,
    failingOperations: report.failingOperations,
    degradedOperations: report.degradedOperations,
    checkedAt: report.checkedAt,
    operations: report.operations
      .filter((o) => o.state !== "idle")
      .map((o) => ({ operation: o.operation, state: o.state, consecutiveFailures: o.consecutiveFailures, failureRatio: o.failureRatio, kind: o.kind, lastOkAt: o.lastOkAt })),
  };
}

/** Probes let through by this process while the provider is down, by operation. */
const probes = new Map<string, number>();

/**
 * Whether the worker should hold LLM work for `operation` instead of calling the provider.
 * While the provider is down, one probe per operation is allowed every LLM_PROBE_INTERVAL_MS;
 * its result is what flips health back to ok.
 */
export async function llmCircuit(operation: string, now = Date.now()): Promise<{ open: boolean; kind: string | null; reason: string | null }> {
  const health = await getLlmHealth();
  if (!health.providerDown) return { open: false, kind: null, reason: null };
  const op = health.operations.find((o) => o.operation === operation);
  const lastRun = Math.max(op?.lastRunAt ? Date.parse(op.lastRunAt) : 0, probes.get(operation) ?? 0);
  const reason = `LLM provider down (${health.kind ?? "outage"}): ${describeLlmFailure(health.kind)}`;
  if (now - lastRun >= LLM_PROBE_INTERVAL_MS) {
    probes.set(operation, now);
    return { open: false, kind: health.kind, reason: null };
  }
  return { open: true, kind: health.kind, reason };
}

/** Put jobs parked during an outage back in the queue now. */
export async function releaseParkedLlmJobs(types?: readonly string[]): Promise<number> {
  const db = await getDb();
  const typeFilter = types?.length ? sql`and ${jobs.type} in (${sql.join(types.map((t) => sql`${t}`), sql`, `)})` : sql``;
  const res = await db
    .update(jobs)
    .set({ runAfter: new Date(), payload: sql`${jobs.payload} - 'llmParked'` })
    .where(sql`${jobs.status} = 'queued' and ${jobs.payload}->'llmParked' is not null ${typeFilter}`)
    .returning();
  return res.length;
}

export type LlmAlertResult = { state: string; providerDown: boolean; alert: "outage" | "recovered" | null; released: number; skipped?: string };

/**
 * Worker tick: alert once when LLM calls start failing and once when they recover, through
 * the notify outbox. The latest llm_health outbox row is the alert state, so restarts and
 * several workers agree. Recovery also releases parked jobs.
 */
export async function checkLlmHealthAlerts(opts: { now?: Date } = {}): Promise<LlmAlertResult> {
  const now = opts.now ?? new Date();
  const health = await getLlmHealth({ fresh: true });
  let released = 0;
  if (!health.providerDown) released = await releaseParkedLlmJobs();
  if (released) log.info("llm.parked_released", { released });

  const db = await getDb();
  const [last] = (
    await db
      .select({ id: notificationOutbox.id, dedupeKey: notificationOutbox.dedupeKey, createdAt: notificationOutbox.createdAt })
      .from(notificationOutbox)
      .where(eq(notificationOutbox.event, "llm_health"))
      .orderBy(desc(notificationOutbox.createdAt), desc(notificationOutbox.id))
      .limit(1)
  ) as Array<{ id: string; dedupeKey: string | null; createdAt: Date } | undefined>;
  const lastPhase = last?.dedupeKey?.startsWith("llm_health:outage:") ? "outage" : last ? "recovered" : null;
  const base = { state: health.state, providerDown: health.providerDown, released };
  const failing = health.state === "failing";
  const { emitNotify } = await import("./notify.js");

  if (failing && lastPhase !== "outage") {
    if (lastPhase === "recovered" && now.getTime() - last!.createdAt.getTime() < LLM_ALERT_COOLDOWN_MS) return { ...base, alert: null, skipped: "cooldown" };
    const ops = health.failingOperations.join(", ");
    const out = await emitNotify({
      event: "llm_health",
      company: "job-scout",
      title: `LLM calls failing (${health.kind ?? "error"})`,
      extra: `${describeLlmFailure(health.kind)}\noperations: ${ops}\nsince ${health.failingSince ?? now.toISOString()}\nLLM jobs are parked; run retry_failed_llm after recovery.`,
      subjectId: "outage",
      revision: health.failingSince ?? now.toISOString(),
    });
    log.warn("llm.health.failing", { kind: health.kind, operations: health.failingOperations, notify: "skipped" in out ? out.skipped : "queued" });
    return "skipped" in out ? { ...base, alert: null, skipped: out.skipped } : { ...base, alert: "outage" };
  }
  if (!failing && lastPhase === "outage") {
    const out = await emitNotify({
      event: "llm_health",
      company: "job-scout",
      title: "LLM calls recovered",
      extra: released ? `${released} parked job(s) released back to the queue.` : "Parked jobs resume on their own; retry_failed_llm re-runs jobs that failed.",
      subjectId: "recovered",
      revision: last!.id,
    });
    log.info("llm.health.recovered", { released, notify: "skipped" in out ? out.skipped : "queued" });
    return "skipped" in out ? { ...base, alert: null, skipped: out.skipped } : { ...base, alert: "recovered" };
  }
  return { ...base, alert: null };
}

/** Pull a parked or backed-off queued job forward (used by retry_failed_llm). */
export async function runQueuedJobNow(jobId: string): Promise<boolean> {
  const db = await getDb();
  const res = await db
    .update(jobs)
    .set({ runAfter: new Date(), payload: sql`${jobs.payload} - 'llmParked'` })
    .where(and(eq(jobs.id, jobId), eq(jobs.status, "queued"), sql`${jobs.runAfter} > now()`))
    .returning();
  return res.length > 0;
}
