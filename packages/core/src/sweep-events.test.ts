import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { boardSources, closeDb, getDb, positions, timelineEvents } from "@job-scout/db";
import type { AtsJob } from "@job-scout/ats";
import { bootstrap } from "./bootstrap.js";
import { repairPositionData } from "./data-repair.js";
import { coreEnv } from "./env.js";
import { runListingClassify } from "./listing-classify.js";
import { getLlmClient } from "./llm.js";
import { getPosition, upsertFromJob } from "./positions.js";
import { scanBoard } from "./scan.js";
import { updateSettings } from "./settings.js";

const dir = mkdtempSync(join(tmpdir(), "job-scout-sweep-events-"));
const events = async (positionId: string) => (await getDb()).select().from(timelineEvents).where(eq(timelineEvents.positionId, positionId));
const job = (company: string, over: Partial<AtsJob> = {}): AtsJob => ({ provider: "greenhouse", boardToken: company, company, jobId: "1", externalIdentity: `greenhouse:${company}:1`,
  title: "Senior Platform Engineer", url: `https://job-boards.greenhouse.io/${company}/jobs/1`, locationRaw: "Remote", descriptionText: "Operate Kubernetes infrastructure. ".repeat(20), listingStatus: "open", ...over });

describe("background mutations leave timeline events (PGlite)", () => {
  beforeAll(async () => {
    delete process.env.DATABASE_URL;
    process.env.PGLITE_DATA_DIR = dir;
    coreEnv.openaiApiKey = "test-only";
    await bootstrap({ seedBoards: false });
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  afterAll(async () => { await closeDb(); rmSync(dir, { recursive: true, force: true }); });

  it("board-close sweep records listing_closed and the archive", async () => {
    await updateSettings({ gate: { titleInclude: ["engineer"], titleExclude: [], allowUnknownGeo: true } });
    const db = await getDb();
    await db.insert(boardSources).values({ id: "brd_sweep", company: "Sweep Example", provider: "ashby", token: "sweep-example" });
    const listing = (ids: string[]) => new Response(JSON.stringify({ jobs: ids.map(id => ({ id, title: `Platform Engineer ${id}`, publishedAt: "2026-10-01", jobUrl: `https://jobs.ashbyhq.com/sweep-example/${id}` })) }), { status: 200 });
    vi.stubGlobal("fetch", vi.fn(async () => listing(["keep", "gone"])));
    await scanBoard("brd_sweep", { force: true });
    const gone = (await db.select().from(positions).where(eq(positions.primaryUrl, "https://jobs.ashbyhq.com/sweep-example/gone")))[0]!;
    await db.update(positions).set({ status: "review" }).where(eq(positions.id, gone.id));
    const before = (await events(gone.id)).length;

    vi.stubGlobal("fetch", vi.fn(async () => listing(["keep"])));
    expect(await scanBoard("brd_sweep", { force: true })).toMatchObject({ closed: 1 });
    const after = await getPosition(gone.id);
    expect(after).toMatchObject({ listingStatus: "closed", status: "archived", archiveReason: "listing_closed" });
    const added = (await events(gone.id)).slice(before);
    expect(added).toHaveLength(2);
    expect(added.find(e => e.kind === "listing_closed")).toMatchObject({ actor: "scan:ashby" });
    expect(added.find(e => e.kind === "status")).toMatchObject({ actor: "scan:ashby", title: "review → archived: listing_closed" });
  });

  it("position-data repair records what it changed", async () => {
    const { position } = await upsertFromJob(job("repair-example"), { status: "review" });
    await (await getDb()).update(positions).set({ listingStatus: "closed" }).where(eq(positions.id, position.id));
    await repairPositionData({ dryRun: false });
    const repair = (await events(position.id)).find(e => e.kind === "repair");
    expect(repair).toMatchObject({ actor: "repair:position-data" });
    expect(repair?.title).toContain("listing_closed");
  });

  it("listing classification records geo/workplace changes only", async () => {
    await updateSettings({ llm: { operations: { listing_classify: { enabled: true, model: "test-model", dailyCap: 0 } } } });
    const result = (geoClass: string) => ({ data: { workplace: "remote", geoClass, evidence: "test" }, content: "{}", model: "test-model", tokensIn: 1, tokensOut: 1, latencyMs: 1 });
    vi.spyOn(getLlmClient(), "chatJson").mockResolvedValue(result("hard_geo") as never);
    const j = job("classify-example");
    const { position } = await upsertFromJob(j);
    expect(position.geoClass).not.toBe("hard_geo");
    await runListingClassify(position.id);
    const classify = (await events(position.id)).filter(e => e.kind === "classify");
    expect(classify).toHaveLength(1);
    expect(classify[0]).toMatchObject({ actor: "listing_classify" });
    expect(classify[0]!.title).toContain("→ remote/hard_geo");

    // Same result on new input: no change, no event.
    const db = await getDb();
    await db.update(positions).set({ metadata: {} }).where(eq(positions.id, position.id));
    await runListingClassify(position.id);
    expect((await events(position.id)).filter(e => e.kind === "classify")).toHaveLength(1);
  });
});
