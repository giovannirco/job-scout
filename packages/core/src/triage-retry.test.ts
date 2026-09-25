import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { closeDb, getDb, jobs, positions } from "@job-scout/db";
import { bootstrap } from "./bootstrap.js";
import { coreEnv } from "./env.js";
import { getLlmClient } from "./llm.js";
import { getPosition, patchPosition, upsertFromJob } from "./positions.js";
import { updateSettings } from "./settings.js";
import { enqueueJob } from "./jobs.js";
import { runTriage } from "./triage.js";
import { startWorker } from "../../../apps/worker/src/loop.js";

const dir = mkdtempSync(join(tmpdir(), "job-scout-triage-retry-"));
const result = { data: { score: 1.5, hardDq: [], oneLiner: "Needs review" }, model: "test-model", tokensIn: 1, tokensOut: 1, latencyMs: 1 };
async function position(name: string) {
  return (await upsertFromJob({ provider: "unknown", company: "Example Systems", title: "Platform Engineer", url: `https://jobs.example/${name}`, listingStatus: "open", descriptionText: "Operate Kubernetes." })).position;
}
describe("discarded triage recovery", () => {
  beforeAll(async () => {
    delete process.env.DATABASE_URL; process.env.PGLITE_DATA_DIR = dir; coreEnv.openaiApiKey = "test-only";
    await bootstrap({ seedBoards: false });
    await updateSettings({ notifications: { enabled: false }, autopilot: { preset: "manual", triageNew: false }, llm: { operations: { triage: { enabled: true, model: "test-model", dailyCap: 0 } } } });
  });
  beforeEach(async () => { await (await getDb()).delete(jobs); });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => { await closeDb(); rmSync(dir, { recursive: true, force: true }); });

  it("requeues a discarded result and refreshes the score without auto-archiving the position", async () => {
    const p = await position("retry"); const db = await getDb();
    const model = vi.spyOn(getLlmClient(), "chatJson").mockImplementationOnce(async () => {
      await db.update(positions).set({ updatedAt: new Date(Date.now() + 1000) }).where(eq(positions.id, p.id)); return result as never;
    }).mockResolvedValue(result as never);
    const q = await enqueueJob("triage", { positionId: p.id });
    const row = async () => (await db.select().from(jobs).where(eq(jobs.id, q.id)))[0];
    const worker = startWorker({ scheduler: false, pollMs: 10, concurrency: 1, types: ["triage"] });
    try {
      await vi.waitFor(async () => expect(await row()).toMatchObject({ status: "queued", attempts: 1, payload: { refreshOnly: true } }));
      expect((await row()).runAfter.getTime()).toBeGreaterThan(Date.now());
      await db.update(jobs).set({ runAfter: new Date() }).where(eq(jobs.id, q.id));
      await vi.waitFor(async () => expect(await row()).toMatchObject({ status: "succeeded", attempts: 2 }));
      expect(model).toHaveBeenCalledTimes(2);
      expect(await getPosition(p.id)).toMatchObject({ status: "triaged", triageScore: 1.5 });
    } finally { await worker.stop(); }
  });

  it("does not retry an operator stage change or a concurrently completed score", async () => {
    const p = await position("operator");
    vi.spyOn(getLlmClient(), "chatJson").mockImplementation(async () => { await patchPosition(p.id, { status: "applied" }); return result as never; });
    expect(await runTriage(p.id)).toMatchObject({ reason: "position_changed", retryable: false });
    vi.restoreAllMocks();
    const other = await position("scored");
    vi.spyOn(getLlmClient(), "chatJson").mockImplementation(async () => {
      await (await getDb()).update(positions).set({ triagedAt: new Date(), triageScore: 4.8, updatedAt: new Date(Date.now() + 1000) }).where(eq(positions.id, other.id)); return result as never;
    });
    expect(await runTriage(other.id)).toMatchObject({ reason: "position_changed", retryable: false });
    expect((await getPosition(other.id))?.triageScore).toBe(4.8);
  });

  it("stops after three attempts and rechecks operator decisions before a queued refresh", async () => {
    const p = await position("bounded"); const db = await getDb();
    const model = vi.spyOn(getLlmClient(), "chatJson").mockImplementation(async () => {
      await db.update(positions).set({ updatedAt: new Date(Date.now() + 1000) }).where(eq(positions.id, p.id)); return result as never;
    });
    const q = await enqueueJob("triage", { positionId: p.id, refreshOnly: true });
    await db.update(jobs).set({ attempts: 2 }).where(eq(jobs.id, q.id));
    const worker = startWorker({ scheduler: false, pollMs: 10, concurrency: 1, types: ["triage"] });
    try {
      await vi.waitFor(async () => expect((await db.select().from(jobs).where(eq(jobs.id, q.id)))[0]).toMatchObject({ status: "failed", attempts: 3 }));
      await patchPosition(p.id, { status: "applied" });
      await db.update(jobs).set({ status: "queued", attempts: 0, runAfter: new Date() }).where(eq(jobs.id, q.id));
      await vi.waitFor(async () => expect((await db.select().from(jobs).where(eq(jobs.id, q.id)))[0]).toMatchObject({ status: "succeeded", result: { reason: "position_no_longer_eligible" } }));
      expect(model).toHaveBeenCalledTimes(1);
    } finally { await worker.stop(); }
  });
});
