/**
 * Paging helpers for list tools whose callers have a ~100 KB tool-result cap.
 * Rows are projected to a lean shape by default, and a page is cut to a byte
 * budget, resuming from the last row kept, so a large pageSize never turns
 * into RESULT_TOO_LARGE.
 */

/** Serialized bytes allowed for the rows of one page; the rest of RESULT_CAP is envelope headroom. */
export const PAGE_BUDGET_BYTES = 80_000;

export type ListFields = "lean" | "full";

type ListRow = {
  id: string;
  slug: string;
  title: string;
  status: string;
  archiveReason?: string | null;
  priority?: string | null;
  primaryUrl?: string | null;
  triageScore?: number | null;
  triageVerdict?: string | null;
  triageOneLiner?: string | null;
  listingStatus?: string | null;
  geoClass?: string | null;
  workplace?: string | null;
  appliedAt?: Date | string | null;
  lastChangedAt?: Date | string | null;
  updatedAt?: Date | string | null;
  careerOps?: Record<string, unknown> | null;
  company?: { slug?: string; name?: string } | null;
  duplicateOfId?: string | null;
  triageStale?: boolean;
  careerOpsStale?: boolean;
};

/** What a sync needs to match and route a row; get_position has the rest. */
export function leanRow(r: ListRow) {
  return {
    id: r.id,
    slug: r.slug,
    title: r.title,
    company: r.company ? { slug: r.company.slug, name: r.company.name } : null,
    status: r.status,
    archiveReason: r.archiveReason ?? null,
    priority: r.priority ?? null,
    primaryUrl: r.primaryUrl ?? null,
    triageScore: r.triageScore ?? null,
    triageVerdict: r.triageVerdict ?? null,
    triageOneLiner: r.triageOneLiner ?? null,
    listingStatus: r.listingStatus ?? null,
    geoClass: r.geoClass ?? null,
    workplace: r.workplace ?? null,
    appliedAt: r.appliedAt ?? null,
    lastChangedAt: r.lastChangedAt ?? null,
    updatedAt: r.updatedAt ?? null,
    careerOps: r.careerOps ?? null,
    ...(r.duplicateOfId !== undefined ? { duplicateOfId: r.duplicateOfId } : {}),
    ...(r.triageStale !== undefined ? { triageStale: r.triageStale } : {}),
    ...(r.careerOpsStale !== undefined ? { careerOpsStale: r.careerOpsStale } : {}),
  };
}

/**
 * Keep rows in order until the next one would pass `budget` bytes of compact
 * JSON. `cursors[i]` resumes after `rows[i]`. When rows are dropped the page is
 * marked truncated and nextCursor resumes after the last row kept; otherwise
 * the caller's own nextCursor stands. At least one row is always kept.
 */
export function fitPage<T>(rows: T[], cursors: (string | null)[], nextCursor: string | null, budget = PAGE_BUDGET_BYTES) {
  let used = 2;
  let n = 0;
  for (const row of rows) {
    const size = Buffer.byteLength(JSON.stringify(row)) + 1;
    if (n > 0 && used + size > budget) break;
    used += size;
    n++;
  }
  if (n >= rows.length) return { items: rows, nextCursor, truncated: false };
  return { items: rows.slice(0, n), nextCursor: cursors[n - 1] ?? nextCursor, truncated: true };
}
