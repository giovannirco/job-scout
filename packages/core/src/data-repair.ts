import { eq, sql } from "drizzle-orm";
import { getDb, jdRevisions, positions } from "@job-scout/db";
import { classifyListing, cleanLocation, employerFromPosting, isNoiseJobTitle, isPlaceholderAtsUrl, LEGACY_SYNTHETIC_POSTING_URLS, requisitionId, unresolvedCompany, UNRESOLVED_COMPANY } from "@job-scout/shared";
import { resolveCompanyForName } from "./companies.js";
import { archivePosition } from "./positions.js";
import { groupingRows, repostFor } from "./position-groups.js";

/** Idempotent, recoverable cleanup. Original values and decisions remain in metadata/history. */
export async function repairPositionData({ dryRun = true } = {}) {
  const db = await getDb();
  const rows = await groupingRows();
  const changes: Array<{ id: string; reasons: string[] }> = [];
  for (const row of rows) {
    const metadata = { ...(row.metadata || {}) };
    const reasons: string[] = [];
    const patch: Record<string, unknown> = {};
    const synthetic = LEGACY_SYNTHETIC_POSTING_URLS.has(row.primaryUrl || "") && ["materials", "applied", "screen", "interview", "offer"].includes(row.status);
    if (synthetic) {
      metadata.synthetic = { kind: "legacy_manual_sibling", originalUrl: row.primaryUrl };
      patch.primaryUrl = null;
      patch.watchEnabled = false;
      reasons.push("synthetic_posting_reference");
    }
    const quarantine = metadata.quarantined as { reason?: string; previousStatus?: string } | undefined;
    if (quarantine?.reason === "placeholder_url" && (!row.primaryUrl?.trim() || synthetic) && !isNoiseJobTitle(row.title) && !unresolvedCompany(row.company)) {
      metadata.recoveredQuarantine = quarantine;
      delete metadata.quarantined;
      reasons.push("recover_missing_url_quarantine");
    }
    const invalid = !synthetic && isPlaceholderAtsUrl(row.primaryUrl) ? "placeholder_url" : isNoiseJobTitle(row.title) ? "junk_title" : null;
    if (invalid && !metadata.quarantined) {
      metadata.quarantined = { reason: invalid, previousStatus: row.status, at: new Date().toISOString() };
      reasons.push(invalid);
    }
    if (unresolvedCompany(row.company) && row.company !== UNRESOLVED_COMPANY) {
      const recovered = employerFromPosting(row.primaryUrl || "", row.title) || UNRESOLVED_COMPANY;
      metadata.originalCompany = row.company;
      reasons.push(`company:${recovered}`);
      if (!dryRun) patch.companyId = (await resolveCompanyForName(recovered)).id;
    }
    const location = cleanLocation(row.locationRaw);
    const ats = (metadata.ats || {}) as { workplaceType?: string; isRemote?: boolean };
    const facts = classifyListing({ locationRaw: location, workplaceType: ats.workplaceType, isRemote: ats.isRemote, company: row.company, title: row.title });
    if (metadata.dataRepairVersion !== 1 || location !== (row.locationRaw || "")) {
      patch.geoClass = facts.geoClass;
      patch.remoteClass = facts.remoteClass;
      patch.workplace = facts.workplace;
      reasons.push("listing_facts");
    }
    if (metadata.dataRepairVersion !== 1 || row.locationRaw?.includes("[object Object]")) {
      const revisions = await db.select().from(jdRevisions).where(eq(jdRevisions.positionId, row.id)).orderBy(sql`revision desc`);
      metadata.requisitionId = requisitionId(revisions[0]?.descriptionText || "");
      const corrupt = revisions.filter(r => r.locationRaw?.includes("[object Object]"));
      if (corrupt.length) {
        metadata.originalLocations = Object.fromEntries(corrupt.map(r => [r.id, r.locationRaw]));
        reasons.push("location_serialization");
        if (!dryRun) for (const r of corrupt) await db.update(jdRevisions).set({ locationRaw: cleanLocation(r.locationRaw) }).where(eq(jdRevisions.id, r.id));
      }
      metadata.dataRepairVersion = 1;
    }
    if (row.listingStatus !== "closed" && !metadata.repostOfId && !invalid) {
      const prior = await repostFor({ ...row, locationRaw: location }, rows.filter(p => (p.firstSeenAt?.getTime() || 0) < (row.firstSeenAt?.getTime() || 0)));
      if (prior) {
        metadata.repostOfId = prior.id;
        metadata.repost = { id: prior.id, status: prior.status, appliedAt: prior.appliedAt?.toISOString() || null, careerOps: prior.metadata?.careerOps || null, reason: "Possible repost: same employer, title and location as a closed posting" };
        reasons.push("repost");
      }
    }
    const close = row.listingStatus === "closed" && ["triaged", "review"].includes(row.status);
    if (close) reasons.push("listing_closed");
    if (!reasons.length) continue;
    changes.push({ id: row.id, reasons });
    if (!dryRun) {
      await db.update(positions).set({ ...patch, metadata, updatedAt: new Date() }).where(eq(positions.id, row.id));
      if (close || (invalid && ["triaged", "review"].includes(row.status))) await archivePosition(row.id, close ? "listing_closed" : `quarantined:${invalid}`, "system");
    }
  }
  return { dryRun, count: changes.length, changes };
}
