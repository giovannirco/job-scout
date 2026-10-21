import { eq, inArray, like, or } from "drizzle-orm";
import { getDb, positions } from "@job-scout/db";
import { isTimezoneOnlyRestriction, mentionsTimezone } from "@job-scout/shared";
import { enqueueJob } from "./jobs.js";
import { addEvent } from "./timeline.js";

/** Text that explains why a position failed or was archived. */
export function failReasonText(p: { archiveReason: string | null; triageJson: unknown }): string {
  const tj = (p.triageJson || {}) as { hardDq?: unknown; oneLiner?: unknown; locationNote?: unknown };
  const hardDq = Array.isArray(tj.hardDq) ? tj.hardDq.map(String) : [];
  return [p.archiveReason, ...hardDq, tj.oneLiner, tj.locationNote].filter((x) => typeof x === "string" && x.trim()).join(" | ");
}

const TRIAGE_ARCHIVE = /^triage (fail|marginal)\b/;

export type RetriageTimezoneRow = {
  id: string;
  title: string;
  status: string;
  verdict: string | null;
  score: number | null;
  reason: string;
  timezoneOnly: boolean;
  forced: boolean;
  /** A triage auto-archive that goes back to `triaged` before the re-triage. */
  revive: boolean;
};

/**
 * Re-triage positions that failed or were auto-archived because of a timezone
 * requirement, which is now informational (or a soft penalty with a profile
 * range). Dry-run unless `apply`. Applying restores triage auto-archives to
 * `triaged` and enqueues a forced triage through the worker queue, so the
 * operation's throttle and caps still apply. Operator archives, closed
 * listings and positions past review are never revived; `include` forces extra
 * position ids into the plan.
 */
export async function retriageTimezoneFails(opts: { apply?: boolean; include?: string[] } = {}) {
  const db = await getDb();
  const include = [...new Set((opts.include ?? []).map((s) => s.trim()).filter(Boolean))];
  const conds = [eq(positions.triageVerdict, "fail"), like(positions.archiveReason, "triage %")];
  if (include.length) conds.push(inArray(positions.id, include));
  const rows = await db
    .select({
      id: positions.id, title: positions.title, status: positions.status, listingStatus: positions.listingStatus,
      archiveReason: positions.archiveReason, triageVerdict: positions.triageVerdict, triageScore: positions.triageScore, triageJson: positions.triageJson,
    })
    .from(positions)
    .where(or(...conds));
  const plan: RetriageTimezoneRow[] = [];
  for (const r of rows) {
    const forced = include.includes(r.id);
    const reason = failReasonText(r);
    const triageArchived = r.status === "archived" && TRIAGE_ARCHIVE.test(r.archiveReason || "");
    const active = r.status === "triaged" || r.status === "review";
    if (!forced) {
      if (!mentionsTimezone(reason)) continue;
      if (r.listingStatus === "closed") continue;
      if (!triageArchived && !(active && r.triageVerdict === "fail")) continue;
    }
    plan.push({
      id: r.id, title: r.title, status: r.status, verdict: r.triageVerdict, score: r.triageScore,
      reason: reason.slice(0, 200), timezoneOnly: isTimezoneOnlyRestriction(reason), forced,
      revive: triageArchived && r.listingStatus !== "closed",
    });
  }
  const missing = include.filter((i) => !rows.some((r) => r.id === i));
  if (!opts.apply) return { dryRun: true as const, count: plan.length, plan, missing };
  const jobs: Array<{ id: string; jobId: string; deduped: boolean }> = [];
  for (const p of plan) {
    if (p.revive) {
      await db.update(positions).set({ status: "triaged", archiveReason: null, updatedAt: new Date() }).where(eq(positions.id, p.id));
      await addEvent({ positionId: p.id, kind: "status", title: "archived → triaged", body: "Timezone policy re-triage: a timezone window alone is not a hard disqualifier.", actor: "repair" });
    }
    const q = await enqueueJob("triage", { positionId: p.id, force: true }, { dedupeKey: `triage:${p.id}`, priority: 40 });
    jobs.push({ id: p.id, jobId: q.id, deduped: q.deduped });
  }
  return { dryRun: false as const, count: plan.length, plan, missing, jobs };
}
