import { z } from "zod";
import { decisionTitle, canonicalCompanySlug, normalizePostingUrl } from "@job-scout/shared";
import { groupingRows } from "./position-groups.js";
import { stampCareerOps } from "./positions.js";

export const TrackerRow = z.object({
  trackerId: z.union([z.string(), z.number()]).transform(String),
  company: z.string().min(1), title: z.string().min(1), url: z.string().optional(),
  score: z.number().min(0).max(5).optional(), status: z.string().optional(),
  reportPath: z.string().optional(), reportExists: z.boolean().optional(),
  updatedAt: z.string().datetime({ offset: true }).optional(),
});
export const ReconcileInput = z.object({ rows: z.array(TrackerRow).max(5000), dryRun: z.boolean().default(true) });

/** URL identity first. Title fallback is exact, unambiguous, and never overrides a conflicting URL. */
export async function reconcileCareerOps(input: z.input<typeof ReconcileInput>) {
  const { rows, dryRun } = ReconcileInput.parse(input);
  const positions = await groupingRows();
  const matches: Array<{ trackerId: string; positionIds: string[]; via: string }> = [];
  const unmatched: string[] = [];
  const conflicts: Array<{ trackerId: string; reason: string }> = [];
  const reports: Array<{ trackerId: string; path: string; status: string }> = [];
  const proposals = new Map<string, { row: z.output<typeof TrackerRow>; ids: string[]; via: string }>();
  for (const row of rows) {
    const url = normalizePostingUrl(row.url);
    let candidates = url ? positions.filter(p => normalizePostingUrl(p.primaryUrl) === url) : [];
    let via = "url";
    if (!candidates.length && !url) {
      via = "company_title";
      candidates = positions.filter(p => canonicalCompanySlug(p.company) === canonicalCompanySlug(row.company) && decisionTitle(p.title) === decisionTitle(row.title));
      if (candidates.length > 1) { conflicts.push({ trackerId: row.trackerId, reason: "ambiguous company/title; provide posting URL" }); continue; }
    }
    if (!candidates.length) { unmatched.push(row.trackerId); continue; }
    if (row.url && !url) { conflicts.push({ trackerId: row.trackerId, reason: "invalid posting URL" }); continue; }
    proposals.set(row.trackerId, { row, ids: candidates.map(p => p.id), via });
  }
  // Validate the whole batch before writing: two tracker rows cannot silently overwrite one another.
  const owners = new Map<string, Set<string>>();
  for (const p of proposals.values()) for (const id of p.ids) owners.set(id, new Set([...(owners.get(id) || []), p.row.trackerId]));
  for (const { row, ids, via } of proposals.values()) {
    if (ids.some(id => owners.get(id)!.size > 1)) { conflicts.push({ trackerId: row.trackerId, reason: "multiple tracker rows claim this position" }); continue; }
    const prior = positions.filter(p => ids.includes(p.id));
    if (prior.some(p => {
      const stamp = (p.metadata?.careerOps || {}) as Record<string, unknown>;
      return (stamp.trackerId && String(stamp.trackerId) !== row.trackerId)
        || (stamp.trackerUpdatedAt && row.updatedAt && String(stamp.trackerUpdatedAt) > row.updatedAt);
    })) { conflicts.push({ trackerId: row.trackerId, reason: "conflicting tracker link or older export" }); continue; }
    const reportStatus = row.reportExists === false ? "missing" : row.reportExists === true ? "verified" : "unverified";
    if (row.reportPath) reports.push({ trackerId: row.trackerId, path: row.reportPath, status: reportStatus });
    matches.push({ trackerId: row.trackerId, positionIds: ids, via });
    if (!dryRun) for (const id of ids) await stampCareerOps(id, {
      trackerId: row.trackerId, ...(row.score !== undefined ? { score: row.score } : {}),
      ...(row.status !== undefined ? { status: row.status } : {}),
      ...(row.reportPath !== undefined ? { reportPath: row.reportPath, reportStatus } : {}),
      ...(row.updatedAt ? { trackerUpdatedAt: row.updatedAt } : {}),
    });
  }
  return { dryRun, matches, unmatched, conflicts, reports };
}
