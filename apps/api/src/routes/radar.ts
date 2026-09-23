import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { boardSources, discoveryFeed, getDb, id } from "@job-scout/db";
import {
  boardErrorKind,
  createWatch,
  deleteWatch,
  discoverySummary,
  enqueueDueBoardScans,
  enqueueJob,
  intakeUrl,
  listBoards,
  listDeltas,
  listDiscovery,
  listWatches,
} from "@job-scout/core";
import { body, fail, ok, queryMap } from "../envelope.js";

export const radarRoutes = new Hono();

radarRoutes.get("/discovery", async (c) => {
  const r = await listDiscovery(queryMap(c));
  return ok(c, r.items, { page: r.page, pageSize: r.pageSize, total: r.total, nextCursor: r.nextCursor });
});

radarRoutes.get("/discovery/summary", async (c) => ok(c, await discoverySummary(Number(c.req.query("hours") || 24))));

/** Promote a discovery row (usually filtered) into the pipeline: fetch JD, create position, triage. */
radarRoutes.post("/discovery/:id/promote", async (c) => {
  const db = await getDb();
  const row = (await db.select().from(discoveryFeed).where(eq(discoveryFeed.id, c.req.param("id"))).limit(1))[0];
  if (!row) return fail(c, "NOT_FOUND", "discovery row not found");
  if (!row.url) return fail(c, "VALIDATION_ERROR", "row has no url");
  try {
    const r = await intakeUrl(row.url, { companyName: row.company || undefined });
    if (!r.position) throw new Error("position missing");
    await db.update(discoveryFeed).set({ positionId: r.position.id, lane: "passed", gateReason: "promoted" }).where(eq(discoveryFeed.id, row.id));
    return ok(c, r.position, { created: r.created, revived: r.revived, triageJobId: r.triageJobId });
  } catch (e) {
    return fail(c, "VALIDATION_ERROR", e instanceof Error ? e.message : String(e));
  }
});

radarRoutes.get("/deltas", async (c) => ok(c, await listDeltas(queryMap(c))));

radarRoutes.get("/boards", async (c) => ok(c, await listBoards(queryMap(c))));

radarRoutes.post("/boards", async (c) => {
  const b = await body<{ company?: string; provider?: string; token?: string; careersUrl?: string; tags?: string[] }>(c);
  if (!b.company || !b.provider || !b.token) return fail(c, "VALIDATION_ERROR", "company, provider, token required");
  const db = await getDb();
  const bid = id("bs");
  await db
    .insert(boardSources)
    .values({ id: bid, company: b.company, provider: b.provider, token: b.token, careersUrl: b.careersUrl ?? null, tags: b.tags ?? [], enabled: true, sourceKind: "ats", capability: "list_api" })
    .onConflictDoNothing();
  const row = (await db.select().from(boardSources).where(eq(boardSources.id, bid)).limit(1))[0];
  if (!row) return fail(c, "CONFLICT", "board with that provider/token already exists");
  await enqueueJob("board_scan", { boardId: bid, company: b.company }, { dedupeKey: `board_scan:${bid}`, priority: 50 });
  return ok(c, { ...row, errorKind: boardErrorKind(row.lastError) }, {}, 201);
});

radarRoutes.patch("/boards/:id", async (c) => {
  const b = await body<{ enabled?: boolean; notes?: string; tags?: string[] }>(c);
  const db = await getDb();
  const set: Record<string, unknown> = {};
  if (typeof b.enabled === "boolean") set.enabled = b.enabled;
  if (typeof b.notes === "string") set.notes = b.notes;
  if (Array.isArray(b.tags)) set.tags = b.tags;
  if (!Object.keys(set).length) return fail(c, "VALIDATION_ERROR", "nothing to update");
  await db.update(boardSources).set(set).where(eq(boardSources.id, c.req.param("id")));
  const row = (await db.select().from(boardSources).where(eq(boardSources.id, c.req.param("id"))).limit(1))[0];
  return row ? ok(c, { ...row, errorKind: boardErrorKind(row.lastError) }) : fail(c, "NOT_FOUND", "board not found");
});

radarRoutes.post("/boards/:id/scan", async (c) => {
  const db = await getDb();
  const row = (await db.select().from(boardSources).where(eq(boardSources.id, c.req.param("id"))).limit(1))[0];
  if (!row) return fail(c, "NOT_FOUND", "board not found");
  const q = await enqueueJob("board_scan", { boardId: row.id, company: row.company, force: c.req.query("force") === "1" }, { dedupeKey: `board_scan:${row.id}`, priority: 40 });
  return ok(c, { jobId: q.id, deduped: q.deduped }, {}, 202);
});

radarRoutes.post("/boards/scan-all", async (c) => ok(c, await enqueueDueBoardScans({ all: c.req.query("all") === "1", limit: Number(c.req.query("limit") || 100) }), {}, 202));

radarRoutes.get("/watches", async (c) => ok(c, await listWatches(queryMap(c))));
radarRoutes.post("/watches", async (c) => {
  const b = await body<{ url?: string; label?: string; positionId?: string }>(c);
  if (!b.url) return fail(c, "VALIDATION_ERROR", "url required");
  return ok(c, { id: await createWatch({ url: b.url, label: b.label, positionId: b.positionId }) }, {}, 201);
});
radarRoutes.delete("/watches/:id", async (c) => {
  await deleteWatch(c.req.param("id"));
  return ok(c, { deleted: true });
});
