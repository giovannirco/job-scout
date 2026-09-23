import { eq, sql } from "drizzle-orm";
import { companies, getDb, positions } from "@job-scout/db";
import { canonicalCompanySlug, canonicalExternalIdentity, decisionTitle, isNoiseJobTitle, isPlaceholderAtsUrl, normalizePostingUrl, unresolvedCompany } from "@job-scout/shared";

export type GroupRow = {
  id: string; title: string; company: string; craftFamily: string | null; contentHash: string | null;
  primaryUrl: string | null; externalIdentity: string | null; status: string; listingStatus: string | null;
  geoClass: string | null; locationRaw: string | null; firstSeenAt: Date | null; appliedAt: Date | null;
  salaryMin: number | null; salaryMax: number | null; salaryCurrency: string | null;
  metadata: Record<string, unknown> | null;
};
export const terminalCareerStatus = (status: unknown) => /^(skip|discarded|rejected|withdrawn|closed)$/i.test(String(status || "").trim());
export const careerStamp = (r: GroupRow) => (r.metadata?.careerOps || {}) as Record<string, unknown>;
export const validOperatorRow = (r: GroupRow) => !isNoiseJobTitle(r.title) && !isPlaceholderAtsUrl(r.primaryUrl) && !unresolvedCompany(r.company) && !r.metadata?.quarantined;
const protectedStatus = (r: GroupRow) => ["materials", "applied", "screen", "interview", "offer"].includes(r.status);

export async function groupingRows(): Promise<GroupRow[]> {
  const db = await getDb();
  // No JD bodies: this bounded personal tracker projection also covers legacy records.
  return db.select({
    id: positions.id, title: positions.title, company: companies.name, craftFamily: positions.craftFamily,
    contentHash: positions.contentHash, primaryUrl: positions.primaryUrl, externalIdentity: positions.externalIdentity,
    status: positions.status, listingStatus: positions.listingStatus, geoClass: positions.geoClass,
    firstSeenAt: positions.firstSeenAt, appliedAt: positions.appliedAt,
    metadata: positions.metadata,
    salaryMin: positions.salaryMin, salaryMax: positions.salaryMax, salaryCurrency: positions.salaryCurrency,
    locationRaw: sql<string | null>`(select location_raw from jd_revisions where position_id = ${positions.id} order by revision desc limit 1)`,
  }).from(positions).innerJoin(companies, eq(positions.companyId, companies.id));
}

function rank(a: GroupRow, b: GroupRow): number {
  const score = (r: GroupRow) => (protectedStatus(r) ? 100 : 0)
    + (r.listingStatus !== "closed" ? 30 : 0) + (r.status !== "archived" ? 10 : 0)
    + (r.geoClass === "brazil_friendly" ? 6 : r.geoClass === "worldwideish" ? 4 : r.geoClass === "hard_geo" ? 0 : 2)
    + (careerStamp(r).trackerId ? 1 : 0);
  return score(b) - score(a) || (a.firstSeenAt?.getTime() || 0) - (b.firstSeenAt?.getTime() || 0) || a.id.localeCompare(b.id);
}

export function groupRows(rows: GroupRow[], families = false): GroupRow[][] {
  const buckets = new Map<string, GroupRow[]>();
  for (const row of rows) {
    const company = canonicalCompanySlug(row.company);
    const req = String(row.metadata?.requisitionId || "");
    // Reposts with known history remain separate decisions even when the JD is identical.
    const history = row.metadata?.repostOfId ? row.id : "";
    const key = families
      ? [company, row.craftFamily, decisionTitle(row.title), req, history].join("|")
      : [company, row.contentHash || row.id, req, history].join("|");
    const bucket = buckets.get(key) || [];
    bucket.push(row);
    buckets.set(key, bucket);
  }
  // Identity duplicates can differ in content (e.g. an old closed shell). Do not destroy either history.
  if (!families) {
    const identities = new Map<string, string>();
    for (const [key, bucket] of [...buckets]) {
      for (const r of bucket) {
        const identity = canonicalExternalIdentity(r.externalIdentity) || normalizePostingUrl(r.primaryUrl);
        if (!identity) continue;
        const prior = identities.get(identity);
        if (prior && prior !== key && buckets.has(prior) && buckets.has(key)) {
          buckets.get(prior)!.push(...buckets.get(key)!);
          buckets.delete(key);
          for (const [id, group] of identities) if (group === key) identities.set(id, prior);
          break;
        }
        identities.set(identity, key);
      }
    }
  }
  return [...buckets.values()].map(bucket => bucket.sort(rank));
}

/** Lowest to highest posted band when every known salary in the family uses one currency. */
export function familySalaryBand(group: Array<Pick<GroupRow, "salaryMin" | "salaryMax" | "salaryCurrency">>): {
  salaryMin: number; salaryMax: number; salaryCurrency: string; familySalarySpan: true;
} | null {
  const known = group.filter((r): r is typeof r & { salaryMin: number; salaryCurrency: string } => r.salaryMin != null && Boolean(r.salaryCurrency));
  if (known.length < 2) return null;
  const currency = known[0].salaryCurrency;
  if (known.some((r) => r.salaryCurrency !== currency)) return null;
  const salaryMin = Math.min(...known.map((r) => r.salaryMin));
  const salaryMax = Math.max(...known.map((r) => r.salaryMax ?? r.salaryMin));
  if (salaryMax < salaryMin) return null;
  return { salaryMin, salaryMax, salaryCurrency: currency, familySalarySpan: true };
}

export function groupSummary(group: GroupRow[]) {
  const representative = group[0];
  const visible = group.some((r) => r.status !== "archived") ? group.filter((r) => r.status !== "archived") : group;
  const band = familySalaryBand(visible);
  return {
    roleFamilyId: representative.id,
    siblingCount: visible.length,
    locations: [...new Set(visible.map(r => r.locationRaw).filter(Boolean))],
    siblings: visible.map(r => ({ id: r.id, title: r.title, status: r.status, location: r.locationRaw, url: r.primaryUrl })),
    ...(band || {}),
  };
}

export async function repostFor(row: Pick<GroupRow, "id" | "company" | "title" | "locationRaw" | "primaryUrl" | "externalIdentity">, rows?: GroupRow[]) {
  const candidates = (rows || await groupingRows()).filter(p => p.id !== row.id && p.listingStatus === "closed"
    && canonicalCompanySlug(p.company) === canonicalCompanySlug(row.company)
    && decisionTitle(p.title) === decisionTitle(row.title)
    && (p.locationRaw || "").toLowerCase().trim() === (row.locationRaw || "").toLowerCase().trim()
    && normalizePostingUrl(p.primaryUrl) !== normalizePostingUrl(row.primaryUrl)
    && (!p.externalIdentity || canonicalExternalIdentity(p.externalIdentity) !== canonicalExternalIdentity(row.externalIdentity)));
  return candidates.sort((a, b) => Number(protectedStatus(b)) - Number(protectedStatus(a)) || (b.firstSeenAt?.getTime() || 0) - (a.firstSeenAt?.getTime() || 0))[0];
}
