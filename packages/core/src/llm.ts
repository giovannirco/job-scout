import { and, desc, eq, gte, inArray, isNotNull, notInArray, sql, type SQL } from "drizzle-orm";
import { getDb, id, llmRuns, positions, type LlmOperation } from "@job-scout/db";
import { createLlmClient, LlmError, type ChatResult, type LlmClient } from "@job-scout/llm";
import { LLM_OPERATION_IDS, type LlmOperationConfig, type LlmOperationId, type Settings } from "@job-scout/shared";
import { coreEnv } from "./env.js";
import { enqueueJob } from "./jobs.js";
import { getSettings, updateSettings } from "./settings.js";
import { llmCalls, llmGate, llmLatency, llmTokens } from "./metrics.js";
import { log as rootLog } from "@job-scout/shared";
const log = rootLog.child({ scope: "llm" });

let client: LlmClient | null = null;
export function getLlmClient(): LlmClient {
  if (!client) {
    client = createLlmClient({
      baseUrl: coreEnv.openaiBaseUrl,
      apiKey: coreEnv.openaiApiKey,
      timeoutMs: coreEnv.llmTimeoutMs,
    });
  }
  return client;
}

export function llmConfigured(): boolean {
  return Boolean(coreEnv.openaiApiKey);
}

export class LlmGateError extends Error {
  code: "disabled" | "no_model" | "cap_reached" | "not_configured" | "budget_reached";
  constructor(code: LlmGateError["code"], message: string) {
    super(message);
    this.name = "LlmGateError";
    this.code = code;
  }
}

export async function runsToday(operation: LlmOperation): Promise<number> {
  const db = await getDb();
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  return (
    await db
      .select({ c: sql<number>`count(*)::int` })
      .from(llmRuns)
      .where(and(eq(llmRuns.operation, operation), gte(llmRuns.createdAt, start)))
  )[0]?.c ?? 0;
}

export type GatedOperation = LlmOperationConfig & { fallbackModel?: string };

/** Resolve model + check enabled/cap for an operation. Throws LlmGateError. */
export async function gateOperation(operation: LlmOperationId, settings?: Settings): Promise<GatedOperation> {
  try {
    return await gateOperationInner(operation, settings);
  } catch (e) {
    if (e instanceof LlmGateError) llmGate.labels({ operation, code: e.code }).inc();
    throw e;
  }
}

async function gateOperationInner(operation: LlmOperationId, settings?: Settings) {
  if (!llmConfigured()) throw new LlmGateError("not_configured", "OPENAI_API_KEY is not set");
  const s = settings ?? (await getSettings());
  const cfg = s.llm.operations[operation];
  if (!cfg || !cfg.enabled) throw new LlmGateError("disabled", `${operation} is disabled in Settings > AI`);
  if (!cfg.model) throw new LlmGateError("no_model", `${operation} has no model selected in Settings > AI`);
  if (cfg.dailyCap > 0) {
    const n = await runsToday(operation);
    if (n >= cfg.dailyCap) throw new LlmGateError("cap_reached", `${operation} hit its daily cap (${cfg.dailyCap})`);
  }
  const budget = s.autopilot.budget;
  if (budget.dailyCalls > 0 || budget.dailyTokens > 0) {
    const t = await totalsToday();
    if (budget.dailyCalls > 0 && t.calls >= budget.dailyCalls)
      throw new LlmGateError("budget_reached", `daily call budget reached (${t.calls}/${budget.dailyCalls})`);
    if (budget.dailyTokens > 0 && t.tokens >= budget.dailyTokens)
      throw new LlmGateError("budget_reached", `daily token budget reached (${t.tokens}/${budget.dailyTokens})`);
  }
  const raw = (s.llm.fallbackModel || "").trim();
  const fallbackModel = raw && raw !== cfg.model ? raw : undefined;
  return { ...cfg, fallbackModel };
}

/** All operations, current UTC day. */
export async function totalsToday(): Promise<{ calls: number; tokens: number }> {
  const db = await getDb();
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  const r = (
    await db
      .select({
        calls: sql<number>`count(*)::int`,
        tokens: sql<number>`coalesce(sum(coalesce(${llmRuns.tokensIn},0) + coalesce(${llmRuns.tokensOut},0)),0)::int`,
      })
      .from(llmRuns)
      .where(gte(llmRuns.createdAt, start))
  )[0];
  return { calls: r?.calls ?? 0, tokens: r?.tokens ?? 0 };
}


/** Cap stored transcripts so one JD-sized prompt cannot dominate the table. */
export const LLM_TRANSCRIPT_MAX_CHARS = 24_000;

function clip(value: string): string {
  if (value.length <= LLM_TRANSCRIPT_MAX_CHARS) return value;
  const kept = LLM_TRANSCRIPT_MAX_CHARS - 80;
  return `${value.slice(0, kept)}\n\n… truncated, ${value.length - kept} more characters not stored …`;
}

/** Anything message-shaped: chat, agent (nullable content plus tool calls), or a raw prompt. */
export type TranscriptMessage = { role?: string; content?: unknown };

/** Render the outbound messages as readable text rather than raw JSON. */
export function renderPrompt(messages?: TranscriptMessage[]): { text: string | null; chars: number | null } {
  if (!messages?.length) return { text: null, chars: null };
  const text = messages
    .map((m) => {
      const body = typeof m.content === "string" ? m.content : m.content == null ? "" : JSON.stringify(m.content, null, 2);
      return `### ${String(m.role || "user").toUpperCase()}\n${body}`;
    })
    .join("\n\n");
  return { text: clip(text), chars: text.length };
}

function renderResponse(out: unknown): { text: string | null; chars: number | null } {
  const r = out as { content?: unknown; json?: unknown } | null;
  const raw =
    typeof r?.content === "string" && r.content.trim()
      ? r.content
      : r?.json !== undefined
        ? JSON.stringify(r.json, null, 2)
        : "";
  if (!raw) return { text: null, chars: null };
  return { text: clip(raw), chars: raw.length };
}

/** Wrap one model call: log to llm_runs whether it succeeds or fails. */
export async function logged<T extends Pick<ChatResult, "model" | "tokensIn" | "tokensOut" | "latencyMs">>(
  operation: LlmOperation,
  model: string,
  positionId: string | null,
  fn: () => Promise<T>,
  /** Outbound messages, stored so the operator can read what was actually asked. */
  messages?: TranscriptMessage[],
): Promise<T> {
  const db = await getDb();
  const t0 = Date.now();
  const prompt = renderPrompt(messages);
  try {
    const out = await fn();
    const usedModel = out.model || model;
    const answer = renderResponse(out);
    await db.insert(llmRuns).values({
      id: id("run"),
      operation,
      model: usedModel,
      positionId,
      status: "ok",
      tokensIn: out.tokensIn,
      tokensOut: out.tokensOut,
      latencyMs: out.latencyMs,
      prompt: prompt.text,
      promptChars: prompt.chars,
      response: answer.text,
      responseChars: answer.chars,
    });
    llmCalls.labels({ operation, model: usedModel, status: "ok" }).inc();
    llmLatency.labels({ operation, model: usedModel }).observe((out.latencyMs ?? Date.now() - t0) / 1000);
    if (out.tokensIn) llmTokens.labels({ operation, model: usedModel, direction: "in" }).inc(out.tokensIn);
    if (out.tokensOut) llmTokens.labels({ operation, model: usedModel, direction: "out" }).inc(out.tokensOut);
    if (usedModel !== model) log.info("llm.fallback", { operation, requested: model, used: usedModel, positionId });
    log.info("llm.call", { operation, model: usedModel, positionId, ms: out.latencyMs, tokensIn: out.tokensIn, tokensOut: out.tokensOut });
    return out;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const ms = Date.now() - t0;
    await db.insert(llmRuns).values({
      id: id("run"),
      operation,
      model,
      positionId,
      status: "error",
      latencyMs: ms,
      error: msg.slice(0, 2000),
      prompt: prompt.text,
      promptChars: prompt.chars,
    });
    llmCalls.labels({ operation, model, status: "error" }).inc();
    llmLatency.labels({ operation, model }).observe(ms / 1000);
    log.warn("llm.call.failed", { operation, model, positionId, ms, err: e });
    throw e;
  }
}

/** Model catalog with a 10 minute cache persisted in settings. */
export async function getModelsCatalog(opts: { force?: boolean } = {}) {
  const s = await getSettings();
  const cachedAt = s.llm.modelsCatalogCachedAt ? new Date(s.llm.modelsCatalogCachedAt).getTime() : 0;
  const fresh = Date.now() - cachedAt < 10 * 60_000;
  if (!opts.force && fresh && s.llm.modelsCatalog.length) {
    return { models: s.llm.modelsCatalog, cachedAt: s.llm.modelsCatalogCachedAt, fromCache: true };
  }
  if (!llmConfigured()) return { models: s.llm.modelsCatalog, cachedAt: s.llm.modelsCatalogCachedAt, fromCache: true, error: "OPENAI_API_KEY not set" };
  try {
    const models = await getLlmClient().listModels();
    const now = new Date().toISOString();
    await updateSettings({ llm: { modelsCatalog: models.map((m) => ({ id: m.id, ownedBy: m.ownedBy })), modelsCatalogCachedAt: now } });
    return { models, cachedAt: now, fromCache: false };
  } catch (e) {
    return {
      models: s.llm.modelsCatalog,
      cachedAt: s.llm.modelsCatalogCachedAt,
      fromCache: true,
      error: e instanceof LlmError ? e.message : String(e),
    };
  }
}

/** Per-operation usage for the last N hours. */
export async function usageSummary(hours = 24) {
  const db = await getDb();
  const since = new Date(Date.now() - hours * 3_600_000);
  const rows = await db
    .select({
      operation: llmRuns.operation,
      runs: sql<number>`count(*)::int`,
      failures: sql<number>`count(*) filter (where ${llmRuns.status} = 'error')::int`,
      tokensIn: sql<number>`coalesce(sum(${llmRuns.tokensIn}),0)::int`,
      tokensOut: sql<number>`coalesce(sum(${llmRuns.tokensOut}),0)::int`,
      avgLatencyMs: sql<number>`coalesce(avg(${llmRuns.latencyMs}),0)::int`,
      lastAt: sql<string | null>`max(${llmRuns.createdAt})`,
    })
    .from(llmRuns)
    .where(gte(llmRuns.createdAt, since))
    .groupBy(llmRuns.operation);
  const today: Record<string, number> = {};
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  const t = await db
    .select({ operation: llmRuns.operation, c: sql<number>`count(*)::int` })
    .from(llmRuns)
    .where(gte(llmRuns.createdAt, start))
    .groupBy(llmRuns.operation);
  for (const r of t) today[r.operation] = r.c;
  const s = await getSettings();
  const remaining = LLM_OPERATION_IDS.map((op) => {
    const cap = s.llm.operations[op]?.dailyCap ?? 0;
    const used = today[op] ?? 0;
    return { operation: op, used, cap, remaining: cap > 0 ? Math.max(0, cap - used) : null };
  });
  return { since: since.toISOString(), byOperation: rows, today, remaining };
}

export async function recentRuns(limit = 50) {
  return (await listLlmRuns({ pageSize: String(Math.min(200, limit)) })).items;
}

export type LlmRunsQuery = {
  operation?: string;
  status?: string;
  model?: string;
  positionId?: string;
  q?: string;
  page?: string | number;
  pageSize?: string | number;
};

/**
 * Slim listing: transcripts can be tens of kilobytes each, so the list returns
 * sizes and a flag, and the body is fetched per run.
 */
export async function listLlmRuns(q: LlmRunsQuery = {}) {
  const db = await getDb();
  const page = Math.max(1, Math.floor(Number(q.page)) || 1);
  const pageSize = Math.min(200, Math.max(1, Math.floor(Number(q.pageSize)) || 50));
  const conds: SQL[] = [];
  if (q.operation) {
    const ops = String(q.operation).split(",").map((o) => o.trim()).filter(Boolean);
    if (ops.length) conds.push(inArray(llmRuns.operation, ops as LlmOperation[]));
  }
  if (q.status) conds.push(eq(llmRuns.status, String(q.status)));
  if (q.model) conds.push(eq(llmRuns.model, String(q.model)));
  if (q.positionId) conds.push(eq(llmRuns.positionId, String(q.positionId)));
  if (q.q) {
    const like = `%${String(q.q).trim()}%`;
    conds.push(sql`(${llmRuns.prompt} ilike ${like} or ${llmRuns.response} ilike ${like} or ${llmRuns.error} ilike ${like})`);
  }
  const where = conds.length ? and(...conds) : undefined;
  const [rows, total] = await Promise.all([
    db
      .select({
        id: llmRuns.id,
        operation: llmRuns.operation,
        model: llmRuns.model,
        positionId: llmRuns.positionId,
        status: llmRuns.status,
        tokensIn: llmRuns.tokensIn,
        tokensOut: llmRuns.tokensOut,
        latencyMs: llmRuns.latencyMs,
        error: llmRuns.error,
        promptChars: llmRuns.promptChars,
        responseChars: llmRuns.responseChars,
        hasTranscript: sql<boolean>`(${llmRuns.prompt} is not null or ${llmRuns.response} is not null)`,
        createdAt: llmRuns.createdAt,
        positionTitle: positions.title,
      })
      .from(llmRuns)
      .leftJoin(positions, eq(llmRuns.positionId, positions.id))
      .where(where)
      .orderBy(desc(llmRuns.createdAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db.select({ c: sql<number>`count(*)::int` }).from(llmRuns).where(where),
  ]);
  return { items: rows, total: total[0]?.c ?? 0, page, pageSize };
}

/** One run with the full stored transcript. */
export async function getLlmRun(runId: string) {
  const db = await getDb();
  const row = (
    await db
      .select({ run: llmRuns, positionTitle: positions.title, positionSlug: positions.slug })
      .from(llmRuns)
      .leftJoin(positions, eq(llmRuns.positionId, positions.id))
      .where(eq(llmRuns.id, runId))
      .limit(1)
  )[0];
  if (!row) return null;
  return {
    ...row.run,
    positionTitle: row.positionTitle,
    positionSlug: row.positionSlug,
    promptTruncated: Boolean(row.run.promptChars && row.run.prompt && row.run.promptChars > row.run.prompt.length),
    responseTruncated: Boolean(row.run.responseChars && row.run.response && row.run.responseChars > row.run.response.length),
  };
}

/** Distinct operations and models present, for the log filter chips. */
export async function llmRunFacets() {
  const db = await getDb();
  const [ops, models] = await Promise.all([
    db.select({ v: llmRuns.operation, c: sql<number>`count(*)::int` }).from(llmRuns).groupBy(llmRuns.operation),
    db.select({ v: llmRuns.model, c: sql<number>`count(*)::int` }).from(llmRuns).groupBy(llmRuns.model),
  ]);
  return { operations: ops, models: models.sort((a, b) => b.c - a.c).slice(0, 40) };
}

export const RETRYABLE_LLM_OPS = [
  "triage",
  "evaluate",
  "materials",
  "jd_review",
  "company_research",
  "form_answers",
  "listing_classify",
] as const;
export type RetryableLlmOp = (typeof RETRYABLE_LLM_OPS)[number];
export type RetryFailedScope = "failed" | "failed_and_missing";

export type RetryFailedItem = {
  positionId: string;
  operation: RetryableLlmOp;
  jobId: string;
  deduped: boolean;
};

export type RetryFailedResult = {
  enqueued: number;
  skipped: number;
  items: RetryFailedItem[];
};

const RETRY_SKIP_STATUS = new Set(["archived", "skip"]);

export async function retryFailedLlm(
  opts: {
    hours?: number;
    scope?: RetryFailedScope;
    operations?: string[];
    limit?: number;
  } = {},
): Promise<RetryFailedResult> {
  const hours = Math.min(168, Math.max(1, Number(opts.hours ?? 24) || 24));
  const limit = Math.min(500, Math.max(1, Number(opts.limit ?? 200) || 200));
  const scope: RetryFailedScope = opts.scope === "failed_and_missing" ? "failed_and_missing" : "failed";
  const allowed = new Set<string>(RETRYABLE_LLM_OPS);
  const ops = (opts.operations?.length ? opts.operations : [...RETRYABLE_LLM_OPS]).filter((o): o is RetryableLlmOp =>
    allowed.has(o),
  );
  if (!ops.length) return { enqueued: 0, skipped: 0, items: [] };

  const db = await getDb();
  const since = new Date(Date.now() - hours * 3_600_000);
  const rows = await db
    .select({
      positionId: llmRuns.positionId,
      operation: llmRuns.operation,
      status: llmRuns.status,
      createdAt: llmRuns.createdAt,
    })
    .from(llmRuns)
    .where(and(isNotNull(llmRuns.positionId), gte(llmRuns.createdAt, since), inArray(llmRuns.operation, ops)))
    .orderBy(desc(llmRuns.createdAt));

  const latest = new Map<string, { positionId: string; operation: RetryableLlmOp; status: string }>();
  for (const r of rows) {
    if (!r.positionId) continue;
    const op = r.operation as RetryableLlmOp;
    const key = `${r.positionId}:${op}`;
    if (latest.has(key)) continue;
    latest.set(key, { positionId: r.positionId, operation: op, status: r.status });
  }

  const candidates: { positionId: string; operation: RetryableLlmOp }[] = [];
  const seen = new Set<string>();
  for (const row of latest.values()) {
    if (row.status !== "error") continue;
    const key = `${row.positionId}:${row.operation}`;
    seen.add(key);
    candidates.push({ positionId: row.positionId, operation: row.operation });
  }

  if (scope === "failed_and_missing" && ops.includes("triage")) {
    const missing = await db
      .select({ id: positions.id })
      .from(positions)
      .where(
        and(
          notInArray(positions.status, ["archived", "skip"]),
          sql`not exists (select 1 from llm_runs r where r.position_id = ${positions.id} and r.operation = 'triage' and r.status = 'ok')`,
        ),
      );
    for (const p of missing) {
      const key = `${p.id}:triage`;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({ positionId: p.id, operation: "triage" });
    }
  }

  const posIds = [...new Set(candidates.map((c) => c.positionId))];
  const posRows = posIds.length
    ? await db
        .select({ id: positions.id, companyId: positions.companyId, status: positions.status })
        .from(positions)
        .where(inArray(positions.id, posIds))
    : [];
  const posMap = new Map(posRows.map((p) => [p.id, p]));

  let skipped = 0;
  const toEnqueue: { positionId: string; operation: RetryableLlmOp; companyId: string }[] = [];
  for (const c of candidates) {
    const p = posMap.get(c.positionId);
    if (!p || RETRY_SKIP_STATUS.has(p.status)) {
      skipped += 1;
      continue;
    }
    toEnqueue.push({ positionId: c.positionId, operation: c.operation, companyId: p.companyId });
  }
  skipped += Math.max(0, toEnqueue.length - limit);
  const sliced = toEnqueue.slice(0, limit);

  const items: RetryFailedItem[] = [];
  for (const c of sliced) {
    const payload =
      c.operation === "company_research"
        ? { companyId: c.companyId, positionId: c.positionId }
        : { positionId: c.positionId, force: true };
    const q = await enqueueJob(c.operation, payload, { dedupeKey: `${c.operation}:${c.positionId}`, priority: 20 });
    items.push({ positionId: c.positionId, operation: c.operation, jobId: q.id, deduped: q.deduped });
  }
  return { enqueued: items.filter((i) => !i.deduped).length, skipped, items };
}

/** One-token smoke call for the Settings "Test" button. */
export async function testModel(model: string) {
  if (!llmConfigured()) throw new LlmGateError("not_configured", "OPENAI_API_KEY is not set");
  const s = await getSettings();
  const raw = (s.llm.fallbackModel || "").trim();
  const fallbackModel = raw && raw !== model ? raw : undefined;
  return logged("test", model, null, () =>
    getLlmClient().chat({
      model,
      fallbackModel,
      messages: [{ role: "user", content: "Reply with the single word: ok" }],
      maxTokens: 5,
      timeoutMs: 30_000,
    }),
  );
}
