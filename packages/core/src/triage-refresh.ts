import { z } from "zod";
import { enqueueJob } from "./jobs.js";
import { gateOperation } from "./llm.js";
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
