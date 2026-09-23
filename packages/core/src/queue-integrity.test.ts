import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { closeDb, getDb, positions, jdRevisions } from "@job-scout/db";
import { bootstrap } from "./bootstrap.js";
import { applySnapshot, getPosition, getPositionDetail, listPositions, patchPosition, upsertFromJob } from "./positions.js";
import { getProfile, profileFingerprint, updateProfile } from "./profile.js";
import { reconcileCareerOps } from "./career-ops.js";
import { repairPositionData } from "./data-repair.js";
import type { AtsJob } from "@job-scout/ats";
import { isPlaceholderAtsUrl, LEGACY_SYNTHETIC_POSTING_URLS } from "@job-scout/shared";

const dir = mkdtempSync(join(tmpdir(), "job-scout-integrity-"));
function job(company: string, id: string, over: Partial<AtsJob> = {}): AtsJob {
  return { provider: "greenhouse", boardToken: company, company, jobId: id, externalIdentity: `greenhouse:${company}:${id}`,
    title: "Senior Site Reliability Engineer", url: `https://job-boards.greenhouse.io/${company}/jobs/${id}`,
    locationRaw: "Brazil, Remote", descriptionText: "Operate Kubernetes and Prometheus in production.", listingStatus: "open", ...over };
}

describe("queue integrity on isolated PGlite", () => {
  beforeAll(async () => {
    delete process.env.DATABASE_URL;
    process.env.PGLITE_DATA_DIR = dir;
    await bootstrap({ seedBoards: false });
  });
  afterAll(async () => { await closeDb(); rmSync(dir, { recursive: true, force: true }); });

  it("collapses identical content before pagination and exposes all links", async () => {
    for (const id of ["1", "2", "3", "4"]) await upsertFromJob(job("duplicates", id), { status: "review" });
    const list = await listPositions({ company: "duplicates", pageSize: "1" });
    expect(list.total).toBe(1);
    expect(list.items[0].duplicateCount).toBe(4);
    expect(list.items[0].siblings).toHaveLength(4);
    expect((await listPositions({ company: "duplicates", includeDuplicates: "true" })).total).toBe(4);
  });

  it("chooses Brazil from a country family and stops asking after packaging", async () => {
    const br = await upsertFromJob(job("countries", "1"), { status: "review" });
    for (const [i, locationRaw] of ["Chile", "Mexico", "Colombia", "Argentina", "Türkiye"].entries()) await upsertFromJob(job("countries", String(i + 2), { locationRaw: `${locationRaw}, Remote` }), { status: "review" });
    const list = await listPositions({ company: "countries", status: "review", actionable: "true", collapseFamilies: "true" });
    expect(list.total).toBe(1);
    expect(list.items[0].id).toBe(br.position.id);
    expect(list.items[0].siblingCount).toBe(6);
    await patchPosition(br.position.id, { status: "materials" });
    expect((await listPositions({ company: "countries", status: "review", actionable: "true", collapseFamilies: "true" })).total).toBe(0);
    expect((await listPositions({ company: "countries", includeDuplicates: "true" })).total).toBe(6);
  });

  it("does not group different seniority or explicit requisition IDs", async () => {
    await upsertFromJob(job("reqs", "1", { requisitionId: "1524" }));
    await upsertFromJob(job("reqs", "2", { requisitionId: "1525" }));
    await upsertFromJob(job("reqs", "3", { title: "Site Reliability Engineer", requisitionId: "1524" }));
    expect((await listPositions({ company: "reqs", collapseFamilies: "true" })).total).toBe(3);
    expect((await listPositions({ company: "reqs" })).total).toBe(3);
  });

  it("archives review on closure, preserves applied history and clears closedAt on reopen", async () => {
    const j = job("lifecycle", "1");
    const { position } = await upsertFromJob(j, { status: "review" });
    await applySnapshot({ positionId: position.id, job: { ...j, listingStatus: "closed" } });
    expect(await getPosition(position.id)).toMatchObject({ status: "archived", archiveReason: "listing_closed" });
    await applySnapshot({ positionId: position.id, job: j });
    expect(await getPosition(position.id)).toMatchObject({ listingStatus: "open", closedAt: null });
    await patchPosition(position.id, { status: "applied" });
    await applySnapshot({ positionId: position.id, job: { ...j, listingStatus: "closed" } });
    expect(await getPosition(position.id)).toMatchObject({ status: "applied", listingStatus: "closed" });
    expect((await listPositions({ company: "lifecycle", actionable: "true" })).total).toBe(0);
  });

  it("does not reopen on an unknown or unparseable observation", async () => {
    const j = job("unknown-state", "1");
    const { position } = await upsertFromJob(j, { status: "applied" });
    await applySnapshot({ positionId: position.id, job: { ...j, listingStatus: "closed" } });
    await applySnapshot({ positionId: position.id, job: { ...j, listingStatus: "unknown", descriptionText: "Parse error" } });
    expect((await getPosition(position.id))?.listingStatus).toBe("closed");
  });

  it("rejects fixtures and junk at creation, keeps existing real titles", async () => {
    for (const title of ["", "Qzuh", "Msi3"]) await expect(upsertFromJob(job("junk", title, { title }))).rejects.toThrow("title");
    await expect(upsertFromJob(job("junk", "fixture", { url: "https://linkedin.com/jobs/view/clip-gauntlet-demo" }))).rejects.toThrow("placeholder");
    const j = job("real-title", "1");
    const { position } = await upsertFromJob(j);
    await applySnapshot({ positionId: position.id, job: { ...j, title: "Qzuh", descriptionText: "" } });
    expect((await getPosition(position.id))?.title).toBe(j.title);
    expect((await listPositions({ company: "junk", includeArchived: "true", includeDuplicates: "true" })).total).toBe(0);
  });

  it("recovers aggregator employer and excludes an unresolved clip", async () => {
    const { position } = await upsertFromJob(job("We Work Remotely", "1", { boardToken: "weworkremotely", company: "We Work Remotely", title: "DevOps Engineer IV (Obs)", url: "https://weworkremotely.com/remote-jobs/jumio-devops-engineer-iv-obs" }));
    expect(position.company.name).toBe("Jumio");
    const mystery = await upsertFromJob({ provider: "linkedin", title: "Platform Engineer", url: "https://linkedin.com/jobs/view/918273", listingStatus: "open" });
    expect(mystery.position.company.name).toBe("__unresolved__");
    expect((await listPositions({ company: "unresolved", actionable: "true" })).total).toBe(0);
  });

  it("aliases board tokens and links a new posting to prior application history", async () => {
    const old = job("gympass", "1000000001", { title: "Staff Platform Engineer | Observability" });
    const { position } = await upsertFromJob(old, { status: "applied" });
    await patchPosition(position.id, { appliedAt: "2020-01-01" });
    const alias = await upsertFromJob({ ...old, company: "Wellhub", boardToken: "wellhub", externalIdentity: "greenhouse:wellhub:1000000001", url: "https://job-boards.greenhouse.io/wellhub/jobs/1000000001" });
    expect(alias.created).toBe(false);
    expect(alias.position.id).toBe(position.id);
    await applySnapshot({ positionId: position.id, job: { ...old, listingStatus: "closed" } });
    const next = await upsertFromJob(job("wellhub", "1000000002", { title: old.title }), { status: "review" });
    expect(next.position.metadata?.repostOfId).toBe(position.id);
    const queue = await listPositions({ company: "Wellhub", status: "review", actionable: "true", collapseFamilies: "true" });
    expect(queue.total).toBe(1);
    expect(queue.items[0].repost).toMatchObject({ status: "applied", appliedAt: "2020-01-01T00:00:00.000Z" });
  });

  it("reconciles URL-first, reports missing paths and excludes terminal stamps", async () => {
    const { position } = await upsertFromJob(job("vtex", "1000000003"), { status: "review" });
    const rows = [{ trackerId: 42, company: "VTEX", title: "different display title", url: "https://boards.greenhouse.io/vtex/jobs/1000000003/?utm_source=tracker", status: "SKIP", score: 3.7, reportPath: "reports/42.md", reportExists: false }];
    const dry = await reconcileCareerOps({ rows });
    expect(dry.matches[0].positionIds).toEqual([position.id]);
    expect((await getPosition(position.id))?.metadata?.careerOps).toBeUndefined();
    const applied = await reconcileCareerOps({ rows, dryRun: false });
    expect(applied.reports[0].status).toBe("missing");
    expect((await listPositions({ company: "vtex", actionable: "true" })).total).toBe(0);
  });

  it("reports ambiguous titles, conflicting URLs and competing tracker rows", async () => {
    const rows = [{ trackerId: 201, company: "duplicates", title: "Senior Site Reliability Engineer" }];
    expect((await reconcileCareerOps({ rows })).conflicts).toHaveLength(1);
    expect((await reconcileCareerOps({ rows: [{ ...rows[0], url: "https://job-boards.greenhouse.io/duplicates/jobs/999" }] })).unmatched).toEqual(["201"]);
    const collision = await reconcileCareerOps({ rows: [201, 202].map(trackerId => ({ ...rows[0], trackerId, url: "https://job-boards.greenhouse.io/duplicates/jobs/1" })), dryRun: false });
    expect(collision.conflicts).toHaveLength(2);
    expect(collision.matches).toHaveLength(0);
  });

  it("marks scores stale when claim inputs change but not on contact edits", async () => {
    const { position } = await upsertFromJob(job("profile-change", "1"));
    const fingerprint = profileFingerprint(await getProfile());
    await (await getDb()).update(positions).set({ triagedAt: new Date(), triageJson: { profileHash: fingerprint }, triageScore: 3.1 }).where(eq(positions.id, position.id));
    await updateProfile({ email: "new-contact@acme.test" });
    expect((await getPositionDetail(position.id))?.triageStale).toBe(false);
    await updateProfile({ scoutBrief: "Production Go and operator/CRD experience." });
    expect((await listPositions({ company: "profile-change", staleProfile: "true" })).total).toBe(1);
    expect((await getPosition(position.id))?.triageScore).toBe(3.1);
  });

  it("repairs legacy records idempotently with recoverable originals", async () => {
    const { position } = await upsertFromJob(job("legacy", "1"), { status: "review" });
    const db = await getDb();
    await db.update(positions).set({ primaryUrl: "https://jobs.ashbyhq.com/railway/example", listingStatus: "closed" }).where(eq(positions.id, position.id));
    await db.update(jdRevisions).set({ locationRaw: "AMER · [object Object]" }).where(eq(jdRevisions.positionId, position.id));
    expect((await repairPositionData()).changes.find(c => c.id === position.id)?.reasons).toContain("placeholder_url");
    expect((await getPosition(position.id))?.status).toBe("review");
    await repairPositionData({ dryRun: false });
    const fixed = await getPositionDetail(position.id);
    expect(fixed?.status).toBe("archived");
    expect(fixed?.metadata?.originalLocations).toBeTruthy();
    expect(fixed?.locationRaw).toBe("AMER");
    expect((await repairPositionData()).count).toBe(0);
  });

  it("recovers URL-less operator work without accepting URL-less ATS ingestion", async () => {
    expect(isPlaceholderAtsUrl(null)).toBe(false);
    expect(isPlaceholderAtsUrl("https://jobs.ashbyhq.com/acme/12345678-0000-0000-0000-123456789abc")).toBe(false);
    await expect(upsertFromJob(job("missing-url", "1", { url: "" }))).rejects.toThrow("placeholder");
    const db = await getDb();
    for (const status of ["materials", "applied"] as const) {
      const { position } = await upsertFromJob(job(`recovery-${status}`, "1"), { status });
      await db.update(positions).set({ primaryUrl: null, metadata: { quarantined: { reason: "placeholder_url", previousStatus: status }, operatorNote: "keep me" } }).where(eq(positions.id, position.id));
      await repairPositionData({ dryRun: false });
      const fixed = await getPosition(position.id);
      expect(fixed?.status).toBe(status);
      expect(fixed?.metadata?.quarantined).toBeUndefined();
      expect(fixed?.metadata?.recoveredQuarantine).toMatchObject({ reason: "placeholder_url" });
      expect(fixed?.metadata?.operatorNote).toBe("keep me");
      expect((await listPositions({ company: `recovery-${status}`, actionable: "true" })).total).toBe(1);
    }
    const { position } = await upsertFromJob(job("other-quarantine", "1"), { status: "materials" });
    await db.update(positions).set({ primaryUrl: null, metadata: { quarantined: { reason: "operator_hold" } } }).where(eq(positions.id, position.id));
    await repairPositionData({ dryRun: false });
    expect((await getPosition(position.id))?.metadata?.quarantined).toMatchObject({ reason: "operator_hold" });
    expect((await repairPositionData()).count).toBe(0);
  });

  it("retains synthetic manual work but retires its fabricated posting URL", async () => {
    const url = [...LEGACY_SYNTHETIC_POSTING_URLS][0];
    await expect(upsertFromJob(job("synthetic", "1", { url }))).rejects.toThrow("placeholder");
    const { position } = await upsertFromJob(job("synthetic", "1"), { status: "materials" });
    await (await getDb()).update(positions).set({ primaryUrl: url, metadata: { quarantined: { reason: "placeholder_url" } } }).where(eq(positions.id, position.id));
    await repairPositionData({ dryRun: false });
    expect(await getPosition(position.id)).toMatchObject({ status: "materials", primaryUrl: null, watchEnabled: false, metadata: { synthetic: { originalUrl: url } } });
    expect((await listPositions({ company: "synthetic", actionable: "true" })).total).toBe(1);
    expect((await repairPositionData()).count).toBe(0);
  });

  it("separates failed reviews while preserving explicit human promotion and reassertion", async () => {
    const { position } = await upsertFromJob(job("review-intent", "1"), { status: "review" });
    await (await getDb()).update(positions).set({ triageVerdict: "fail", triageScore: 0 }).where(eq(positions.id, position.id));
    const query = { company: "review-intent", status: "review", actionable: "true" };
    expect((await listPositions({ ...query, reviewLane: "pending" })).total).toBe(0);
    expect((await listPositions({ ...query, reviewLane: "failed" })).total).toBe(1);
    await patchPosition(position.id, { status: "review" }, "operator");
    expect((await listPositions({ ...query, reviewLane: "pending" })).total).toBe(1);
    expect((await listPositions({ ...query, reviewLane: "failed" })).total).toBe(0);
    await patchPosition(position.id, { status: "triaged" }, "system");
    await patchPosition(position.id, { status: "review" }, "autopilot");
    expect((await listPositions({ ...query, reviewLane: "pending" })).total).toBe(0);
    await patchPosition(position.id, { status: "triaged" }, "operator");
    await patchPosition(position.id, { status: "review" }, "operator");
    // Existing installations have timeline evidence but no reviewIntent marker.
    await (await getDb()).update(positions).set({ metadata: {} }).where(eq(positions.id, position.id));
    expect((await listPositions({ ...query, reviewLane: "pending" })).total).toBe(1);
  });
});
