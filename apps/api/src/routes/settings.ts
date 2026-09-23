import { Hono } from "hono";
import bcrypt from "bcryptjs";
import { desc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { apiTokens, getDb, id } from "@job-scout/db";
import {
  getModelsCatalog,
  getProfile,
  getSettings,
  sendTestNotify,
  wahaConfigured,
  jobStats,
  listJobs,
  llmConfigured,
  recentRuns,
  listLlmRuns,
  getLlmRun,
  llmRunFacets,
  runRetention,
  testModel,
  updateProfile,
  updateSettings,
  usageSummary,
  enqueueJob,
  retryFailedLlm,
  coreEnv,
  LlmGateError,
  autopilotSummary,
  browserStatus,
  totalsToday,
  regateRecentDiscovery,
  syncGateFromTargetRoles,
  titleIncludesFromRoles,
} from "@job-scout/core";
import { applyAutopilotPreset, AUTOPILOT_PRESET_VALUES, LLM_OPERATION_IDS } from "@job-scout/shared";
import { body, fail, ok } from "../envelope.js";
import { env } from "../env.js";

export const settingsRoutes = new Hono();

settingsRoutes.get("/", async (c) => ok(c, await getSettings({ fresh: true })));
settingsRoutes.get("/notifications", async (c) => {
  const s = await getSettings({ fresh: true });
  return ok(c, { ...s.notifications, wahaConfigured: wahaConfigured() });
});
settingsRoutes.post("/notifications/test", async (c) => {
  const b = (await body(c)) as { channel?: string };
  const channel = b.channel || "desk";
  return ok(c, await sendTestNotify(channel));
});

settingsRoutes.patch("/", async (c) => {
  try {
    const patch = await body(c);
    const before = await getSettings({ fresh: true });
    const next = await updateSettings(patch);
    const gateChanged = patch.gate != null && JSON.stringify(before.gate) !== JSON.stringify(next.gate);
    const regate = gateChanged ? await regateRecentDiscovery() : null;
    return ok(c, next, regate ? { regate } : {});
  } catch (e) {
    return fail(c, "VALIDATION_ERROR", e instanceof Error ? e.message : String(e));
  }
});

settingsRoutes.get("/profile", async (c) => ok(c, await getProfile()));
settingsRoutes.patch("/profile", async (c) => {
  const patch = await body(c);
  const before = await getProfile();
  const next = await updateProfile(patch);
  const rolesChanged =
    Array.isArray(patch.targetRoles) &&
    JSON.stringify(titleIncludesFromRoles(before.targetRoles)) !== JSON.stringify(titleIncludesFromRoles(next.targetRoles));
  const synced = rolesChanged ? await syncGateFromTargetRoles(next.targetRoles) : null;
  return ok(c, next, synced ? { regate: synced.regate, titleInclude: synced.titleInclude } : {});
});

/** Settings > AI */
settingsRoutes.get("/llm/models", async (c) => {
  const r = await getModelsCatalog({ force: c.req.query("refresh") === "1" });
  const groups: Record<string, string[]> = {};
  for (const m of r.models) (groups[m.ownedBy || "other"] ||= []).push(m.id);
  return ok(c, { models: r.models, groups, cachedAt: r.cachedAt, fromCache: r.fromCache, error: (r as { error?: string }).error ?? null });
});

settingsRoutes.get("/llm/status", async (c) => {
  const s = await getSettings();
  const usage = await usageSummary(24);
  return ok(c, {
    configured: llmConfigured(),
    baseUrl: coreEnv.openaiBaseUrl,
    fallbackModel: s.llm.fallbackModel,
    operations: LLM_OPERATION_IDS.map((op) => ({
      id: op,
      ...s.llm.operations[op],
      today: usage.today[op] ?? 0,
      last24h: usage.byOperation.find((r) => r.operation === op) ?? null,
    })),
    usage,
  });
});

settingsRoutes.get("/llm/runs", async (c) =>
  ok(
    c,
    await listLlmRuns({
      operation: c.req.query("operation"),
      status: c.req.query("status"),
      model: c.req.query("model"),
      positionId: c.req.query("positionId"),
      q: c.req.query("q"),
      page: c.req.query("page"),
      pageSize: c.req.query("pageSize") || c.req.query("limit"),
    }),
  ),
);
settingsRoutes.get("/llm/runs/facets", async (c) => ok(c, await llmRunFacets()));
settingsRoutes.get("/llm/runs/:id", async (c) => {
  const run = await getLlmRun(c.req.param("id"));
  return run ? ok(c, run) : fail(c, "NOT_FOUND", "llm run not found", undefined, 404);
});

settingsRoutes.post("/llm/retry", async (c) => {
  const b = await body<{ hours?: number; scope?: "failed" | "failed_and_missing"; operations?: string[]; limit?: number }>(c);
  const r = await retryFailedLlm(b);
  return ok(c, r, {}, 202);
});

settingsRoutes.post("/llm/test", async (c) => {
  const b = await body<{ model?: string }>(c);
  if (!b.model) return fail(c, "VALIDATION_ERROR", "model required");
  try {
    const r = await testModel(b.model);
    return ok(c, { model: r.model, content: r.content, latencyMs: r.latencyMs, tokensIn: r.tokensIn, tokensOut: r.tokensOut });
  } catch (e) {
    if (e instanceof LlmGateError) return fail(c, "LLM_GATE", e.message, { code: e.code });
    return fail(c, "INTERNAL", e instanceof Error ? e.message : String(e), {}, 502);
  }
});

/** Autopilot */
settingsRoutes.get("/autopilot", async (c) => {
  const s = await getSettings({ fresh: true });
  return ok(c, { ...s.autopilot, presets: AUTOPILOT_PRESET_VALUES, summary: await autopilotSummary(), budgetToday: await totalsToday() });
});
settingsRoutes.post("/autopilot/preset", async (c) => {
  const b = await body<{ preset?: string }>(c);
  if (!b.preset || !(b.preset in AUTOPILOT_PRESET_VALUES)) return fail(c, "VALIDATION_ERROR", "preset must be manual | assisted | autopilot");
  const s = await getSettings();
  const next = applyAutopilotPreset(s.autopilot, b.preset as "manual" | "assisted" | "autopilot");
  const saved = await updateSettings({ autopilot: next });
  return ok(c, saved.autopilot);
});

/** System */
settingsRoutes.get("/system", async (c) =>
  ok(c, {
    version: env.version,
    authMode: env.authMode,
    publicBaseUrl: env.publicBaseUrl,
    llmBaseUrl: coreEnv.openaiBaseUrl,
    llmConfigured: llmConfigured(),
    browser: await browserStatus(),
    jobs: await jobStats(),
  }),
);
settingsRoutes.get("/system/browser", async (c) => ok(c, await browserStatus()));
settingsRoutes.get("/system/jobs", async (c) =>
  ok(c, await listJobs({ status: c.req.query("status"), type: c.req.query("type"), limit: Number(c.req.query("limit") || 50) })),
);
settingsRoutes.post("/system/retention", async (c) => ok(c, await runRetention()));
settingsRoutes.post("/system/jobs", async (c) => {
  const b = await body<{ type?: string; payload?: Record<string, unknown> }>(c);
  if (!b.type) return fail(c, "VALIDATION_ERROR", "type required");
  const q = await enqueueJob(b.type as never, b.payload || {}, { priority: 50 });
  return ok(c, q, {}, 202);
});

/** API tokens (agents / MCP / career-ops skill) */
settingsRoutes.get("/tokens", async (c) => {
  const db = await getDb();
  const rows = await db
    .select({ id: apiTokens.id, name: apiTokens.name, tokenPrefix: apiTokens.tokenPrefix, scopes: apiTokens.scopes, lastUsedAt: apiTokens.lastUsedAt, revokedAt: apiTokens.revokedAt, createdAt: apiTokens.createdAt })
    .from(apiTokens)
    .orderBy(desc(apiTokens.createdAt));
  return ok(c, rows);
});
settingsRoutes.post("/tokens", async (c) => {
  const b = await body<{ name?: string; scopes?: string[] }>(c);
  if (!b.name) return fail(c, "VALIDATION_ERROR", "name required");
  const token = `js_${nanoid(32)}`;
  const db = await getDb();
  const tid = id("tok");
  await db.insert(apiTokens).values({ id: tid, name: b.name, tokenHash: await bcrypt.hash(token, 10), tokenPrefix: token.slice(0, 8), scopes: b.scopes?.length ? b.scopes : ["agent", "mcp"] });
  return ok(c, { id: tid, name: b.name, token }, {}, 201);
});
settingsRoutes.delete("/tokens/:id", async (c) => {
  const db = await getDb();
  await db.update(apiTokens).set({ revokedAt: new Date() }).where(eq(apiTokens.id, c.req.param("id")));
  return ok(c, { revoked: true });
});
