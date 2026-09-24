import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { closeDb, getDb, jobs } from "@job-scout/db";
import { jobRecovery } from "@job-scout/shared";
import { bootstrap } from "./bootstrap.js";
import { enqueueJob, failJob, retryFailedScan } from "./jobs.js";
import { startWorker } from "../../../apps/worker/src/loop.js";
import { upsertFromJob } from "./positions.js";
import * as fetcher from "./fetch-job.js";

const dir = mkdtempSync(join(tmpdir(), "job-scout-recovery-"));

describe("failed scan recovery", () => {
  beforeAll(async () => { delete process.env.DATABASE_URL; process.env.PGLITE_DATA_DIR = dir; await bootstrap({ seedBoards: false }); });
  afterAll(async () => { await closeDb(); rmSync(dir, { recursive: true, force: true }); });
  it("distinguishes blocked, unsafe and transient sources", () => {
    expect(jobRecovery("watch_check", "url fetch failed: 403")).toMatchObject({ kind: "blocked", retryable: false });
    expect(jobRecovery("scan_url", "ATS URL must address a public HTTP(S) service on port 80 or 443").retryable).toBe(false);
    for (const e of ["fetch failed", "This operation was aborted", "url fetch failed: 503", "HTTP 429"]) expect(jobRecovery("watch_check", e).retryable).toBe(true);
    expect(jobRecovery("triage", "fetch failed")).toMatchObject({ kind: "model", retryable: false });
  });
  it("requeues the same failed check once and preserves its target", async () => {
    const original = await enqueueJob("watch_check", { positionId: "synthetic-position" }, { dedupeKey: "watch:synthetic-position" });
    await failJob(original.id, "fetch failed");
    expect(await retryFailedScan(original.id)).toEqual({ id: original.id, deduped: false });
    const row = (await (await getDb()).select().from(jobs).where(eq(jobs.id, original.id)))[0];
    expect(row).toMatchObject({ status: "queued", attempts: 0, error: null, finishedAt: null, payload: { positionId: "synthetic-position" } });
    await expect(retryFailedScan(original.id)).rejects.toThrow("Only failed");
  });
  it("does not retry blocked requests or duplicate existing pending checks", async () => {
    const blocked = await enqueueJob("watch_check", { positionId: "blocked" });
    await failJob(blocked.id, "url fetch failed: 403");
    await expect(retryFailedScan(blocked.id)).rejects.toThrow("browser");
    const failed = await enqueueJob("board_scan", { boardId: "example" }, { dedupeKey: "board:example" });
    await failJob(failed.id, "fetch failed");
    const pending = await enqueueJob("board_scan", { boardId: "example" }, { dedupeKey: "board:example" });
    expect(await retryFailedScan(failed.id)).toEqual({ id: pending.id, deduped: true });
    const legacy = await enqueueJob("board_scan", { boardId: "example", force: true });
    await failJob(legacy.id, "fetch failed");
    expect(await retryFailedScan(legacy.id)).toEqual({ id: pending.id, deduped: true });
    const invalid = await enqueueJob("watch_check", {});
    await failJob(invalid.id, "fetch failed");
    await expect(retryFailedScan(invalid.id)).rejects.toThrow("no target");
    await expect(retryFailedScan("missing")).rejects.toThrow("not found");
  });
  it("automatically retries a transient scan and stops after the third attempt", async () => {
    const { position } = await upsertFromJob({ provider: "greenhouse", boardToken: "worker-test", jobId: "1", company: "Example Systems",
      title: "Platform Engineer", url: "https://boards.greenhouse.io/worker-test/jobs/1", listingStatus: "open" });
    const check = await enqueueJob("watch_check", { positionId: position.id });
    const fetch = vi.spyOn(fetcher, "fetchJob").mockRejectedValue(new Error("fetch failed"));
    const worker = startWorker({ scheduler: false, pollMs: 10, concurrency: 1, types: ["watch_check"] });
    const db = await getDb();
    const row = async () => (await db.select().from(jobs).where(eq(jobs.id, check.id)))[0];
    try {
      await vi.waitFor(async () => expect(await row()).toMatchObject({ status: "queued", attempts: 1, error: "fetch failed" }));
      expect((await row()).runAfter.getTime()).toBeGreaterThan(Date.now());
      await db.update(jobs).set({ attempts: 2, runAfter: new Date() }).where(eq(jobs.id, check.id));
      await vi.waitFor(async () => expect(await row()).toMatchObject({ status: "failed", attempts: 3 }));
    } finally { await worker.stop(); fetch.mockRestore(); }
  });

});
