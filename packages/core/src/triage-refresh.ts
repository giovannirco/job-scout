import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { getDb, jobs } from "@job-scout/db";
import { z } from "zod";
import { enqueueJob } from "./jobs.js";
import { gateOperation, operationUnavailable } from "./llm.js";
import { listPositions } from "./positions.js";

export const RefreshStaleTriageInput = z.object({
  limit: z.number().int().min(1).max(25).default(25),
  dryRun: z.boolean().default(true),
});

/** Refresh the highest-ranked stale decision candidates, without downstream actions. */
export async function refreshStaleTriage(input: unknown = {}) {
  const { limit, dryRun } = RefreshStaleTriageInput.parse(input);
  const candidates = await listPositions({ status: "triaged,review", verdict: "pass", actionable: "true",
    collapseFamilies: "true", staleProfile: "true", sort: "score_desc", pageSize: String(limit) });
  if (!dryRun && candidates.items.length) await gateOperation("triage");
  const items = [];
  for (const p of candidates.items) {
    const queued = dryRun ? null : await enqueueJob("triage", { positionId: p.id, refreshOnly: true },
      { dedupeKey: `triage:${p.id}`, priority: 20 });
    items.push({ id: p.id, slug: p.slug, title: p.title, company: p.company.name,
      jobId: queued?.id ?? null, deduped: queued?.deduped ?? false });
  }
  return { dryRun, total: candidates.total, selected: items.length,
    enqueued: items.filter(p => p.jobId && !p.deduped).length,
    deduped: items.filter(p => p.deduped).length, items };
}

/** Read refresh progress across reloads, including jobs waiting on a budget. */
export async function triageRefreshStatus() {
  const preview = await refreshStaleTriage();
  const unavailable = await operationUnavailable("triage");
  const db = await getDb();
  const ids = preview.items.map(p => p.id);
  const rows = ids.length ? await db.select().from(jobs).where(and(eq(jobs.type, "triage"),
    inArray(sql<string>`${jobs.payload}->>'positionId'`, ids))).orderBy(desc(jobs.createdAt), desc(jobs.id)) : [];
  return { total: preview.total, unavailable, items: preview.items.map(p => {
    const candidates = rows.filter(j => j.payload?.positionId === p.id);
    const job = candidates.find(j => j.status === "running" || j.status === "queued") ?? candidates.at(0);
    return { id: p.id, state: job?.status === "queued" && job.runAfter > new Date() ? "waiting" :
      job && ["queued", "running", "failed"].includes(job.status) ? job.status : "needed",
      jobId: job?.id ?? null, retryAt: job?.status === "queued" ? job.runAfter : null,
      error: job?.status === "failed" || job?.status === "queued" ? job.error : null };
  }) };
}
