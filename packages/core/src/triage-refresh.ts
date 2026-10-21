import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { getDb, jobs } from "@job-scout/db";
import { log as rootLog } from "@job-scout/shared";
import { z } from "zod";
import { enqueueJob } from "./jobs.js";
import { gateOperation, operationUnavailable, runsToday } from "./llm.js";
import { getLlmHealth } from "./llm-health.js";
import { clearRepairedChangedBadges, listPositions } from "./positions.js";
import { getSettings } from "./settings.js";

const log = rootLog.child({ scope: "stale-sweep" });

export const RefreshStaleTriageInput = z.object({
  limit: z.number().int().min(1).max(25).default(25),
  dryRun: z.boolean().default(true),
});

type RefreshOptions = {
  /** Verdict filter (comma list); null takes every verdict. Default: pass. */
  verdict?: string | null;
  /** Default score_desc; the scheduled sweep takes the oldest triage first. */
  sort?: "score_desc" | "triaged_asc";
  /** Leave these positions out of the selection (e.g. a refresh already ran today). */
  exclude?: (ids: string[]) => Promise<Set<string>>;
};

/** Refresh the highest-ranked stale decision candidates, without downstream actions. */
export async function refreshStaleTriage(input: unknown = {}, opts: RefreshOptions = {}) {
  const { limit, dryRun } = RefreshStaleTriageInput.parse(input);
  const verdict = opts.verdict === undefined ? "pass" : opts.verdict;
  // Over-fetch when excluding so the excluded rows do not starve the page.
  const candidates = await listPositions({ status: "triaged,review", ...(verdict ? { verdict } : {}), actionable: "true",
    collapseFamilies: "true", staleProfile: "true", sort: opts.sort ?? "score_desc", pageSize: String(opts.exclude ? 200 : limit) });
  const skip = opts.exclude ? await opts.exclude(candidates.items.map(p => p.id)) : new Set<string>();
  const selected = candidates.items.filter(p => !skip.has(p.id)).slice(0, limit);
  if (!dryRun && selected.length) await gateOperation("triage");
  const items = [];
  for (const p of selected) {
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

/** Positions with a triage job created in the last day: a refresh that skipped (e.g. needs a JD) waits a day. */
async function triagedRecently(ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const db = await getDb();
  const rows = await db.select({ positionId: sql<string>`${jobs.payload}->>'positionId'` }).from(jobs).where(and(
    eq(jobs.type, "triage"), gte(jobs.createdAt, new Date(Date.now() - 24 * 3_600_000)),
    inArray(sql<string>`${jobs.payload}->>'positionId'`, ids)));
  return new Set(rows.map(r => r.positionId));
}

export type StaleSweepResult = {
  skipped?: string;
  enqueued: number;
  deduped: number;
  selected: number;
  stale: number;
  changedBadgesCleared: number;
};

/**
 * Scheduled, capped stale-triage sweep (runs with the watch tick). Re-scores the oldest
 * stale triage among active positions (triaged/review, open, not quarantined or terminal in
 * career-ops) with score-only refreshes, up to triage.staleSweepMaxRows per run and at most
 * half of what is left of the daily triage cap, so new intake keeps the rest. Skips entirely
 * while the provider is down or triage is gated. Also drops "changed" badges no material
 * revision backs. Never throws: the watch run that hosts it must not fail because of it.
 */
export async function sweepStaleTriage(): Promise<StaleSweepResult> {
  const out: StaleSweepResult = { enqueued: 0, deduped: 0, selected: 0, stale: 0, changedBadgesCleared: 0 };
  try {
    const settings = await getSettings();
    if (!settings.triage.staleSweepEnabled) return { ...out, skipped: "disabled" };
    out.changedBadgesCleared = (await clearRepairedChangedBadges()).cleared;
    if ((await getLlmHealth({ fresh: true }).catch(() => null))?.providerDown) return { ...out, skipped: "provider_down" };
    const unavailable = await operationUnavailable("triage");
    if (unavailable) return { ...out, skipped: `triage_unavailable: ${unavailable}` };
    let rows = settings.triage.staleSweepMaxRows;
    const cap = settings.llm.operations.triage?.dailyCap ?? 0;
    if (cap > 0) {
      const db = await getDb();
      const pending = (await db.select({ c: sql<number>`count(*)::int` }).from(jobs)
        .where(and(eq(jobs.type, "triage"), inArray(jobs.status, ["queued", "running"]))))[0]?.c ?? 0;
      rows = Math.min(rows, Math.floor((cap - (await runsToday("triage")) - pending) / 2));
      if (rows < 1) return { ...out, skipped: "daily_cap" };
    }
    const r = await refreshStaleTriage({ limit: rows, dryRun: false }, { verdict: null, sort: "triaged_asc", exclude: triagedRecently });
    return { ...out, enqueued: r.enqueued, deduped: r.deduped, selected: r.selected, stale: r.total };
  } catch (e) {
    log.error("stale_sweep.failed", { err: e });
    return { ...out, skipped: `error: ${e instanceof Error ? e.message : String(e)}` };
  }
}
