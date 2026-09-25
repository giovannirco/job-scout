import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { closeDb, getDb, jobs, positions, watches } from "@job-scout/db";
import { bootstrap } from "./bootstrap.js";
import { upsertFromJob } from "./positions.js";
import { checkPosition, checkWatch, createWatch, enqueueDueWatchChecks } from "./watch.js";
import { enqueueJob, failJob } from "./jobs.js";
import * as fetcher from "./fetch-job.js";

const dir = mkdtempSync(join(tmpdir(), "job-scout-watch-scheduling-"));
const old = new Date(Date.now() - 48 * 3_600_000);
async function position(name: string, url = `https://jobs.example/${name}`) {
  const { position: p } = await upsertFromJob({ provider: "unknown", company: "Example Systems", title: "Platform Engineer",
    url: `https://jobs.example/${name}`, descriptionText: "Operate infrastructure.", listingStatus: "open" }, { status: "interview" });
  await (await getDb()).update(positions).set({ primaryUrl: url, lastCheckedAt: old }).where(eq(positions.id, p.id));
  return p.id;
}
describe("watch scheduling", () => {
  beforeAll(async () => { delete process.env.DATABASE_URL; process.env.PGLITE_DATA_DIR = dir; await bootstrap({ seedBoards: false }); });
  beforeEach(async () => { const db = await getDb(); await db.delete(jobs); await db.delete(watches); await db.update(positions).set({ status: "archived", watchEnabled: false }); });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => { await closeDb(); rmSync(dir, { recursive: true, force: true }); });

  it("skips imported, private and malformed URLs in both scheduler and already-queued checks", async () => {
    const fetch = vi.spyOn(fetcher, "fetchJob");
    const ids = await Promise.all([position("local", "local://imported-role"), position("private", "http://127.0.0.1/job"), position("malformed", "https://")]);
    const legacy = await createWatch({ url: "local://legacy-role" });
    expect(await enqueueDueWatchChecks()).toEqual({ due: 0, enqueued: 0 });
    for (const id of ids) expect(await checkPosition(id)).toMatchObject({ skipped: "unsupported_url" });
    expect(await checkWatch(legacy)).toMatchObject({ skipped: "unsupported_url" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("cools down blocked positions and legacy watches without hiding the failure or starving healthy checks", async () => {
    const id = await position("blocked");
    const legacy = await createWatch({ url: "https://jobs.example/legacy-blocked" });
    vi.spyOn(fetcher, "fetchJob").mockRejectedValue(new Error("url fetch failed: 403"));
    await expect(checkPosition(id)).rejects.toThrow("403");
    const blocked = await enqueueJob("watch_check", { positionId: id, url: "https://jobs.example/blocked" });
    const legacyJob = await enqueueJob("watch_check", { watchId: legacy, url: "https://jobs.example/legacy-blocked" });
    await failJob(blocked.id, "url fetch failed: 403"); await failJob(legacyJob.id, "HTTP 403 Forbidden");
    const healthy = await position("healthy");
    expect(await enqueueDueWatchChecks({ limit: 1 })).toEqual({ due: 1, enqueued: 1 });
    const db = await getDb();
    expect((await db.select().from(jobs).where(eq(jobs.status, "queued"))).map(j => j.payload?.positionId)).toEqual([healthy]);
    expect((await db.select().from(positions).where(eq(positions.id, id)))[0]).toMatchObject({ status: "interview", listingStatus: "open", lastCheckedAt: old });
    await db.update(jobs).set({ finishedAt: old }).where(eq(jobs.status, "failed"));
    expect(await enqueueDueWatchChecks()).toEqual({ due: 3, enqueued: 2 });
  });

  it("allows a corrected URL and does not apply the blocked-site cooldown to transient failures", async () => {
    const id = await position("corrected");
    const blocked = await enqueueJob("watch_check", { positionId: id, url: "https://jobs.example/corrected" });
    await failJob(blocked.id, "url fetch failed: 403");
    await (await getDb()).update(positions).set({ primaryUrl: "https://jobs.example/new-location" }).where(eq(positions.id, id));
    const transient = await position("temporary");
    const failed = await enqueueJob("watch_check", { positionId: transient }); await failJob(failed.id, "url fetch failed: 503");
    expect(await enqueueDueWatchChecks()).toEqual({ due: 2, enqueued: 2 });
  });
});
