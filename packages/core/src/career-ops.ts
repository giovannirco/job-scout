import { z } from "zod";
import { decisionTitle, canonicalCompanySlug, normalizePostingUrl } from "@job-scout/shared";
import { careerStamp, groupingRows, type GroupRow } from "./position-groups.js";
import { patchPosition, stampCareerOps, upsertFromJob } from "./positions.js";
import { careerOpsDropStatus, mapCareerOpsStatus, noteCareerOpsDrop } from "./career-ops-status.js";

export const TrackerRow = z.object({
  trackerId: z.union([z.string(), z.number()]).transform(String),
  company: z.string().min(1), title: z.string().min(1), url: z.string().optional(),
  score: z.number().min(0).max(5).optional(), status: z.string().optional(),
  reportPath: z.string().optional(), reportExists: z.boolean().optional(),
  updatedAt: z.string().datetime({ offset: true }).optional(),
});
export const ReconcileInput = z.object({ rows: z.array(TrackerRow).max(5000), dryRun: z.boolean().default(true) });

const sameRole = (p: GroupRow, company: string, title: string) =>
  canonicalCompanySlug(p.company) === canonicalCompanySlug(company) && decisionTitle(p.title) === decisionTitle(title);

/**
 * The position a tracker row already maps to: the position stamped with its trackerId
 * (unless that position has a different posting URL than the row now gives), else, for a
 * row without a URL, the one manual URL-less position with the same company and role (when the
 * row has a trackerId, one whose stamp names no other tracker row). `ambiguous` when several match.
 */
export function matchCareerOpsRow(rows: GroupRow[], row: { trackerId?: string | null; company: string; title: string; url?: string | null }):
  { id: string; via: "trackerId" | "company_title"; primaryUrl: string | null } | { ambiguous: string[] } | null {
  const url = normalizePostingUrl(row.url);
  const trackerId = row.trackerId ? String(row.trackerId) : "";
  if (trackerId) {
    const stamped = rows.filter(p => String(careerStamp(p).trackerId ?? "") === trackerId);
    const usable = stamped.filter(p => !url || !p.primaryUrl || normalizePostingUrl(p.primaryUrl) === url);
    if (usable.length === 1) return { id: usable[0].id, via: "trackerId", primaryUrl: usable[0].primaryUrl };
    if (usable.length > 1) return { ambiguous: usable.map(p => p.id) };
  }
  if (url) return null;
  const manual = rows.filter(p => !p.primaryUrl && sameRole(p, row.company, row.title)
    && (!trackerId || !careerStamp(p).trackerId || String(careerStamp(p).trackerId) === trackerId));
  if (manual.length === 1) return { id: manual[0].id, via: "company_title", primaryUrl: null };
  if (manual.length > 1) return { ambiguous: manual.map(p => p.id) };
  return null;
}

/** A manual position for a tracker row with no posting URL: company + role, status mapped from the tracker. */
export async function createManualCareerOpsPosition(row: { company: string; title: string; status?: string }) {
  const { position } = await upsertFromJob({ provider: "other", title: row.title, company: row.company, url: "", listingStatus: "unknown" },
    { source: "career-ops", companyName: row.company, status: "review", allowMissingUrl: true });
  if (careerOpsDropStatus(row.status)) await noteCareerOpsDrop(position.id, String(row.status));
  const mapped = mapCareerOpsStatus(row.status);
  if (mapped && mapped !== position.status) await patchPosition(position.id, { status: mapped }, "career-ops");
  return position;
}

/**
 * Give a URL-less position the posting URL its tracker row now carries, through the
 * listing-correction path (public URL guard, ATS identity). A URL another position
 * already holds is reported, not merged.
 */
export async function setCareerOpsUrl(positionId: string, url: string): Promise<{ urlSet: true } | { conflict: string }> {
  try {
    await patchPosition(positionId, { primaryUrl: url }, "career-ops");
    return { urlSet: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/^(url_conflict|invalid_url):/.test(msg)) return { conflict: msg };
    throw e;
  }
}

/**
 * Tracker link first (a position already stamped with the row's trackerId), then URL identity.
 * Title fallback is exact, unambiguous, and never overrides a conflicting URL. Rows without a
 * URL that match nothing become manual positions on a real run (dry run: `wouldCreate`), except
 * rows the tracker dropped (`skippedDropped`); a URL
 * that appears later for a stamped URL-less position is set on it (`urlSet`).
 */
export async function reconcileCareerOps(input: z.input<typeof ReconcileInput>) {
  const { rows, dryRun } = ReconcileInput.parse(input);
  const positions = await groupingRows();
  const matches: Array<{ trackerId: string; positionIds: string[]; via: string }> = [];
  const unmatched: string[] = [];
  const conflicts: Array<{ trackerId: string; reason: string }> = [];
  const reports: Array<{ trackerId: string; path: string; status: string }> = [];
  const created: Array<{ trackerId: string; positionId: string }> = [];
  const wouldCreate: string[] = [];
  // A row the tracker dropped (Discarded, SKIP…, Withdrawn) never becomes an active position.
  const skippedDropped: string[] = [];
  const urlSet: Array<{ trackerId: string; positionId: string; url: string }> = [];
  const proposals = new Map<string, { row: z.output<typeof TrackerRow>; ids: string[]; via: string }>();
  for (const row of rows) {
    const url = normalizePostingUrl(row.url);
    if (row.url?.trim() && !url) { conflicts.push({ trackerId: row.trackerId, reason: "invalid posting URL" }); continue; }
    const linked = matchCareerOpsRow(positions, { trackerId: row.trackerId, company: row.company, title: row.title, url: row.url });
    if (linked && "ambiguous" in linked) { conflicts.push({ trackerId: row.trackerId, reason: "ambiguous tracker link or company/title; provide posting URL" }); continue; }
    if (linked) { proposals.set(row.trackerId, { row, ids: [linked.id], via: linked.via }); continue; }
    let candidates = url ? positions.filter(p => normalizePostingUrl(p.primaryUrl) === url) : [];
    let via = "url";
    if (!candidates.length && !url) {
      via = "company_title";
      candidates = positions.filter(p => canonicalCompanySlug(p.company) === canonicalCompanySlug(row.company) && decisionTitle(p.title) === decisionTitle(row.title));
      if (candidates.length > 1) { conflicts.push({ trackerId: row.trackerId, reason: "ambiguous company/title; provide posting URL" }); continue; }
    }
    if (!candidates.length) {
      unmatched.push(row.trackerId);
      if (!url) (careerOpsDropStatus(row.status) ? skippedDropped : wouldCreate).push(row.trackerId);
      continue;
    }
    proposals.set(row.trackerId, { row, ids: candidates.map(p => p.id), via });
  }
  const stampOf = (row: z.output<typeof TrackerRow>) => {
    const reportStatus = row.reportExists === false ? "missing" : row.reportExists === true ? "verified" : "unverified";
    return {
      trackerId: row.trackerId, ...(row.score !== undefined ? { score: row.score } : {}),
      ...(row.status !== undefined ? { status: row.status } : {}),
      ...(row.reportPath !== undefined ? { reportPath: row.reportPath, reportStatus } : {}),
      ...(row.updatedAt ? { trackerUpdatedAt: row.updatedAt } : {}),
    };
  };
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
    const url = normalizePostingUrl(row.url);
    if (url && row.url) for (const p of prior.filter(p => !p.primaryUrl)) {
      if (dryRun) { urlSet.push({ trackerId: row.trackerId, positionId: p.id, url: row.url }); continue; }
      const r = await setCareerOpsUrl(p.id, row.url);
      if ("urlSet" in r) urlSet.push({ trackerId: row.trackerId, positionId: p.id, url: row.url });
      else conflicts.push({ trackerId: row.trackerId, reason: r.conflict });
    }
    if (!dryRun) for (const id of ids) await stampCareerOps(id, stampOf(row));
  }
  if (!dryRun) {
    const seen = new Set<string>();
    for (const trackerId of wouldCreate) {
      if (seen.has(trackerId)) continue;
      seen.add(trackerId);
      const row = rows.find(r => r.trackerId === trackerId)!;
      const position = await createManualCareerOpsPosition({ company: row.company, title: row.title, status: row.status });
      await stampCareerOps(position.id, stampOf(row));
      created.push({ trackerId, positionId: position.id });
    }
  }
  const createdIds = new Set(created.map(c => c.trackerId));
  return { dryRun, matches, unmatched: unmatched.filter(t => !createdIds.has(t)), conflicts, reports, created,
    ...(dryRun ? { wouldCreate } : {}), skippedDropped, urlSet };
}
