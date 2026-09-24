import { z } from "zod";
import { listPositions, type ListPositionsQuery } from "@job-scout/core";

const lanes = ["decide", "review", "applied", "marginal", "failedReview"] as const;
export const WorkQueueInput = z.object({
  limit: z.number().int().min(1).max(100).default(20),
  page: z.number().int().min(1).default(1),
  lane: z.enum(lanes).optional(),
});
const filters: Record<typeof lanes[number], ListPositionsQuery> = {
  decide: { status: "triaged", verdict: "pass", sort: "score_desc", actionable: "true", collapseFamilies: "true" },
  review: { status: "review", reviewLane: "pending", sort: "updated_desc", actionable: "true", collapseFamilies: "true" },
  applied: { status: "applied", sort: "updated_desc" },
  marginal: { status: "triaged", verdict: "marginal", sort: "score_desc", actionable: "true", collapseFamilies: "true" },
  failedReview: { status: "review", reviewLane: "failed", sort: "score_desc", actionable: "true", collapseFamilies: "true" },
};

export async function workQueue(input: z.input<typeof WorkQueueInput> = {}) {
  const { limit, page, lane } = WorkQueueInput.parse(input);
  const selected = lane ? [lane] : lanes;
  const results = await Promise.all(selected.map(async name => {
    const r = await listPositions({ ...filters[name], pageSize: String(limit), page: String(page) });
    return { name, total: r.total, items: r.items.map(p => ({
      id: p.id, slug: p.slug, title: p.title.slice(0, 200),
      company: { id: p.company.id, name: p.company.name.slice(0, 120) },
      status: p.status, listingStatus: p.listingStatus,
      triageScore: p.triageScore, triageVerdict: p.triageVerdict, triageStale: p.triageStale,
      triageOneLiner: p.triageOneLiner?.slice(0, 400) ?? null,
      summaryShortened: p.title.length > 200 || p.company.name.length > 120 || (p.triageOneLiner?.length ?? 0) > 400,
      locationRaw: p.locationRaw?.slice(0, 200) ?? null, updatedAt: p.updatedAt,
    })) };
  }));
  return {
    ...Object.fromEntries(results.map(r => [r.name, r.items])),
    pagination: Object.fromEntries(results.map(r => [r.name, {
      total: r.total, page, limit, nextPage: page * limit < r.total ? page + 1 : null,
    }])),
  };
}
