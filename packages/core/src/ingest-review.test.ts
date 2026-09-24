import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, getDb, discoveryFeed, id, positions, jdRevisions } from "@job-scout/db";
import { bootstrap } from "./bootstrap.js";
import { archivePosition, upsertFromJob, listPositions } from "./positions.js";
import { intakeUrl } from "./scan.js";
import { getSettings, updateSettings } from "./settings.js";
import { syncGateFromTargetRoles } from "./profile.js";
import * as fetching from "./fetch-job.js";

const dir = mkdtempSync(join(tmpdir(), "job-scout-ingest-review-"));
describe("public review ingest regressions", () => {
  beforeAll(async () => { delete process.env.DATABASE_URL; process.env.PGLITE_DATA_DIR = dir; await bootstrap({ seedBoards: false }); });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => { await closeDb(); rmSync(dir, { recursive: true, force: true }); });

  it("preserves archive decisions on discovery intake but allows explicit operator reopening", async () => {
    const job = { provider: "unknown" as const, title: "Platform Engineer", company: "Review Labs", url: "https://careers.review-labs.test/jobs/1001", descriptionText: "Operate production infrastructure", locationRaw: "Remote", listingStatus: "open" as const };
    vi.spyOn(fetching, "fetchJob").mockResolvedValue(job);
    await updateSettings({ gate: { titleInclude: ["platform engineer"], titleExclude: [], geoAllow: [], geoBlock: [], maxPostingAgeDays: 0 } });
    const created = await upsertFromJob(job, { source: "scan:discovery" });
    await archivePosition(created.position.id, "operator declined");
    const scanned = await intakeUrl(job.url, { source: "scan:discovery" });
    expect(scanned.position?.status).toBe("archived");
    expect(scanned.revived).toBe(false);
    const manual = await intakeUrl(job.url);
    expect(manual.position?.status).toBe("triaged");
    expect(manual.revived).toBe(true);
  });

  it("does not file a rejected job just because another board reused its numeric id", async () => {
    const base = { provider: "greenhouse" as const, jobId: "1001", title: "Platform Engineer", descriptionText: "Build systems", locationRaw: "Remote", listingStatus: "open" as const };
    await upsertFromJob({ ...base, company: "First Board", boardToken: "first-board", externalIdentity: "greenhouse:first-board:1001", url: "https://boards.greenhouse.io/first-board/jobs/1001" });
    const rejected = { ...base, title: "Sales Associate", company: "Second Board", boardToken: "second-board", externalIdentity: "greenhouse:second-board:1001", url: "https://boards.greenhouse.io/second-board/jobs/1001" };
    vi.spyOn(fetching, "fetchJob").mockResolvedValue(rejected);
    const result = await intakeUrl(rejected.url, { source: "scan:discovery" });
    expect(result.skipped).toBe(true);
    expect((await listPositions({ company: "Second Board", includeArchived: "true" })).total).toBe(0);
  });

  it("paginates discovery ties after grouping without replaying old observations", async () => {
    const { listDiscovery } = await import("./radar.js");
    const db = await getDb();
    const when = new Date();
    await db.insert(discoveryFeed).values(Array.from({ length: 3 }, (_, i) => ({
      id: id("df"), externalIdentity: `cursor:${i}`, company: "Cursor Synthetic", title: "Role",
      url: `https://example.com/${i}`, lane: "passed" as const, observedAt: when,
    })));
    const first = await listDiscovery({ q: "Cursor Synthetic", pageSize: "2" });
    const second = await listDiscovery({ q: "Cursor Synthetic", pageSize: "2", cursor: first.nextCursor! });
    expect(first.items).toHaveLength(2);
    expect(second.items).toHaveLength(1);
    expect(new Set([...first.items, ...second.items].map(r => r.id)).size).toBe(3);
    expect((await listDiscovery({ q: "Cursor Synthetic", pageSize: "2", sort: "posted_desc" })).nextCursor).toBeNull();
    await expect(listDiscovery({ cursor: first.nextCursor!, sort: "posted_desc" })).rejects.toThrow("cursor requires");
  });

  it("includes home listings beyond the old 2000-row cap and keeps repaired hashes aligned", async () => {
    const { updateProfile } = await import("./profile.js");
    const { decodeStoredJdEntities } = await import("./positions.js");
    const { eq } = await import("drizzle-orm");
    await updateProfile({ location: "Austin, TX" });
    const home = await upsertFromJob({ provider: "unknown", company: "Cap Fixture", title: "Capfixture Engineer", url: "https://careers.review-labs.test/jobs/home", descriptionText: "Build &mdash; software", locationRaw: "Austin, TX", listingStatus: "open" });
    const db = await getDb();
    await db.update(positions).set({ updatedAt: new Date(0), geoClass: "hard_geo" }).where(eq(positions.id, home.position.id));
    await db.insert(positions).values(Array.from({ length: 2000 }, (_, i) => ({
      id: `cap-${i}`, slug: `cap-${i}`, companyId: home.position.companyId, title: "Capfixture Engineer",
      geoClass: "hard_geo", updatedAt: new Date(),
    })));
    const found = await listPositions({ q: "Capfixture", geoClass: "home", sort: "updated_desc" });
    expect(found.total).toBe(1);
    expect(found.items[0]?.id).toBe(home.position.id);
    await decodeStoredJdEntities();
    const row = (await db.select().from(positions).where(eq(positions.id, home.position.id)))[0]!;
    const revision = (await db.select().from(jdRevisions).where(eq(jdRevisions.positionId, row.id)))[0]!;
    expect(revision.descriptionText).toBe("Build — software");
    expect(revision.contentHash).toBe(row.contentHash);
  });

  it("clears the title gate when the operator clears all target roles", async () => {
    await syncGateFromTargetRoles(["Java Engineer"]);
    expect((await getSettings()).gate.titleInclude).toContain("java");
    await syncGateFromTargetRoles([]);
    expect((await getSettings()).gate.titleInclude).toEqual([]);
  });
});
