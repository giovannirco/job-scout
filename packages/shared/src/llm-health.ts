/**
 * LLM health: pure classification and assessment over recent llm_runs rows.
 *
 * The runs table is the shared truth between the API and worker processes, so health is
 * derived from it rather than from in-memory counters: the API reports it, the worker
 * parks jobs on it and alerts on its transitions.
 */

/** Why calls fail. Everything except `error` points at the provider rather than one job. */
export const LLM_FAILURE_KINDS = ["auth", "quota", "upgrade_required", "outage", "error"] as const;
export type LlmFailureKind = (typeof LLM_FAILURE_KINDS)[number];

export type LlmHealthState = "ok" | "degraded" | "failing" | "idle";

export const LLM_HEALTH_DEFAULTS = {
  /** Latest N runs per operation that are considered. */
  sample: 20,
  /** This many failures in a row (newest first) mark the operation failing. */
  consecutiveFailures: 3,
  /** Window for the failure ratio. */
  windowMs: 30 * 60_000,
  /** Ratio at or above which an operation with enough runs is degraded. */
  degradedRatio: 0.5,
  /** Minimum runs in the window before the ratio counts. */
  minRunsForRatio: 4,
  /** A failure this fast with no tokens is the provider refusing, not the model thinking. */
  fastFailMs: 1_500,
} as const;
export type LlmHealthThresholds = typeof LLM_HEALTH_DEFAULTS;

/** While failing, one probe call per operation is let through this often. */
export const LLM_PROBE_INTERVAL_MS = 5 * 60_000;
/** Parked jobs come back after this long unless recovery releases them sooner. */
export const LLM_PARK_MS = 15 * 60_000;
/** After a recovery alert, a new outage alert waits this long (flapping guard). */
export const LLM_ALERT_COOLDOWN_MS = 30 * 60_000;

export type LlmRunSample = {
  operation: string;
  status: string;
  error?: string | null;
  latencyMs?: number | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  createdAt: Date | string;
};

function statusOf(error: string, status?: number | null): number | null {
  if (status != null) return status;
  const m = error.match(/\bllm (\d{3})\b/);
  return m ? Number(m[1]) : null;
}

/** Classify one failed call. `latencyMs`/tokens let a silent instant refusal count as an outage. */
export function classifyLlmFailure(input: { error?: string | null; status?: number | null; latencyMs?: number | null; tokens?: number | null }, fastFailMs: number = LLM_HEALTH_DEFAULTS.fastFailMs): LlmFailureKind {
  const text = String(input.error || "").toLowerCase();
  const status = statusOf(text, input.status);
  // The model answered; the answer was wrong. Its text may mention anything.
  if (/llm output failed schema/.test(text)) return "error";
  if (status === 426 || /upgrade required|client (is )?(outdated|too old)|outdated client|update your client|unsupported client version|please upgrade/.test(text)) return "upgrade_required";
  if (status === 401 || status === 403 || /invalid api key|incorrect api key|invalid_api_key|unauthori[sz]ed|authentication|forbidden|api key (is )?(missing|revoked|expired)/.test(text)) return "auth";
  if (status === 402 || status === 429 || /insufficient[_ ](quota|balance|credits?|funds)|quota[_ ]exceeded|exceeded your (current )?quota|out of credits|credit limit|billing|balance|payment required|rate[_ ]limit|usage[_ ]limit/.test(text)) return "quota";
  if ((status != null && status >= 500) || /timeout|timed out|econn|enotfound|eai_again|socket hang up|fetch failed|network|empty completion|stream ended without|service unavailable|bad gateway|overloaded/.test(text)) return "outage";
  const tokens = input.tokens ?? 0;
  if (input.latencyMs != null && input.latencyMs < fastFailMs && !tokens) return "outage";
  return "error";
}

export function providerWideKind(kind: LlmFailureKind | null | undefined): boolean {
  return kind != null && kind !== "error";
}

export type LlmOperationHealth = {
  operation: string;
  state: LlmHealthState;
  /** Newest-first failures before the latest success. */
  consecutiveFailures: number;
  windowRuns: number;
  windowFailures: number;
  failureRatio: number;
  /** Most common kind among the current failure streak, else among window failures. */
  kind: LlmFailureKind | null;
  lastRunAt: string | null;
  lastOkAt: string | null;
  lastErrorAt: string | null;
  /** When the current failure streak began. */
  failingSince: string | null;
};

export type LlmHealthReport = {
  state: LlmHealthState;
  /** Provider-wide failure (auth/quota/upgrade/outage) on a failing operation: park LLM work. */
  providerDown: boolean;
  kind: LlmFailureKind | null;
  failingOperations: string[];
  degradedOperations: string[];
  /** Earliest streak start among failing operations. */
  failingSince: string | null;
  operations: LlmOperationHealth[];
  checkedAt: string;
};

const iso = (d: Date | string | null | undefined) => (d == null ? null : new Date(d).toISOString());

function dominant(kinds: LlmFailureKind[]): LlmFailureKind | null {
  if (!kinds.length) return null;
  const counts = new Map<LlmFailureKind, number>();
  for (const k of kinds) counts.set(k, (counts.get(k) ?? 0) + 1);
  // Ties go to the most specific signal: upgrade > auth > quota > outage > error.
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || LLM_FAILURE_KINDS.indexOf(a[0]) - LLM_FAILURE_KINDS.indexOf(b[0]))[0]![0];
}

export function assessOperation(operation: string, runs: LlmRunSample[], opts: { now?: Date; thresholds?: Partial<LlmHealthThresholds> } = {}): LlmOperationHealth {
  const t = { ...LLM_HEALTH_DEFAULTS, ...opts.thresholds };
  const now = (opts.now ?? new Date()).getTime();
  const sorted = [...runs].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, t.sample);
  const kindOf = (r: LlmRunSample) => classifyLlmFailure({ error: r.error, latencyMs: r.latencyMs, tokens: (r.tokensIn ?? 0) + (r.tokensOut ?? 0) }, t.fastFailMs);
  const streak: LlmRunSample[] = [];
  for (const r of sorted) {
    if (r.status === "ok") break;
    streak.push(r);
  }
  const window = sorted.filter((r) => now - new Date(r.createdAt).getTime() <= t.windowMs);
  const windowFailures = window.filter((r) => r.status !== "ok");
  const failureRatio = window.length ? windowFailures.length / window.length : 0;
  const lastOk = sorted.find((r) => r.status === "ok");
  const lastErr = sorted.find((r) => r.status !== "ok");
  let state: LlmHealthState;
  if (!sorted.length) state = "idle";
  else if (streak.length >= t.consecutiveFailures) state = "failing";
  else if (window.length >= t.minRunsForRatio && failureRatio >= t.degradedRatio) state = "degraded";
  else if (streak.length > 0 && !lastOk) state = "degraded";
  else state = "ok";
  const kind = dominant((streak.length ? streak : windowFailures).map(kindOf));
  return {
    operation,
    state,
    consecutiveFailures: streak.length,
    windowRuns: window.length,
    windowFailures: windowFailures.length,
    failureRatio: Math.round(failureRatio * 1000) / 1000,
    kind,
    lastRunAt: iso(sorted[0]?.createdAt),
    lastOkAt: iso(lastOk?.createdAt),
    lastErrorAt: iso(lastErr?.createdAt),
    failingSince: streak.length ? iso(streak[streak.length - 1]!.createdAt) : null,
  };
}

/** Assess every operation present in `runs` (plus any listed in `operations`). */
export function assessLlmHealth(runs: LlmRunSample[], opts: { now?: Date; operations?: readonly string[]; thresholds?: Partial<LlmHealthThresholds> } = {}): LlmHealthReport {
  const byOp = new Map<string, LlmRunSample[]>();
  for (const op of opts.operations ?? []) byOp.set(op, []);
  for (const r of runs) {
    const list = byOp.get(r.operation) ?? [];
    list.push(r);
    byOp.set(r.operation, list);
  }
  const operations = [...byOp.entries()].map(([op, rows]) => assessOperation(op, rows, opts)).sort((a, b) => a.operation.localeCompare(b.operation));
  const failing = operations.filter((o) => o.state === "failing");
  const degraded = operations.filter((o) => o.state === "degraded");
  const providerFailing = failing.filter((o) => providerWideKind(o.kind));
  const state: LlmHealthState = failing.length ? "failing" : degraded.length ? "degraded" : operations.some((o) => o.state === "ok") ? "ok" : "idle";
  const since = failing.map((o) => o.failingSince).filter((s): s is string => Boolean(s)).sort()[0] ?? null;
  return {
    state,
    providerDown: providerFailing.length > 0,
    kind: dominant((providerFailing.length ? providerFailing : failing.length ? failing : degraded).map((o) => o.kind).filter((k): k is LlmFailureKind => k != null)),
    failingOperations: failing.map((o) => o.operation),
    degradedOperations: degraded.map((o) => o.operation),
    failingSince: since,
    operations,
    checkedAt: new Date(opts.now ?? Date.now()).toISOString(),
  };
}

/** Numeric form for Prometheus: 0 ok/idle, 1 degraded, 2 failing. */
export function llmHealthStateValue(state: LlmHealthState): number {
  return state === "failing" ? 2 : state === "degraded" ? 1 : 0;
}

const KIND_ADVICE: Record<LlmFailureKind, string> = {
  auth: "the provider rejected the API key",
  quota: "the provider reports quota, balance or rate limits",
  upgrade_required: "the provider says the client is outdated (upgrade required)",
  outage: "the provider is unreachable or failing fast",
  error: "calls are failing",
};

export function describeLlmFailure(kind: LlmFailureKind | null): string {
  return KIND_ADVICE[kind ?? "error"];
}
