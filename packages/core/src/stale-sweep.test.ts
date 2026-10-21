import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { closeDb, getDb, id as newId, jdRevisions, jobs, llmRuns, positions } from "@job-scout/db";
import { bootstrap } from "./bootstrap.js";
import { coreEnv } from "./env.js";
import { getLlmClient } from "./llm.js";
import * as llmHealth from "./llm-health.js";
import { getPosition, upsertFromJob } from "./positions.js";
import { updateSettings } from "./settings.js";
import { sweepStaleTriage } from "./triage-refresh.js";

/** Synthetic role detail: enough JD to score (see jdSufficiency). */
const DUTIES = " You will own CI/CD pipelines, on-call rotations, incident reviews, capacity planning and cost reports. We expect solid Linux, networking and scripting skills, clear written communication, and care for reliable, observable services that teams can trust.";
const dir = mkdtempSync(join(tmpdir(), "job-scout-stale-sweep-"));
let seq = 0;

type Over = { status?: "triaged" | "review" | "applied" | "archived"; verdict?: "pass" | "marginal" | "fail"; daysAgo?: number; listingStatus?: string; metadata?: Record<string, unknown> };
async function stale(over: Over = {}) {
  const n = ++seq;
  const name = `example-sweep-${n}`;
  const { position } = await upsertFromJob({ provider: "greenhouse", boardToken: name, jobId: String(n), company: `Example Sweep ${n}`,
    title: "Platform Engineer", url: `https://boards.greenhouse.io/${name}/jobs/${n}`, locationRaw: "Remote",
    descriptionText: "Operate Kubernetes infrastructure." + DUTIES, listingStatus: "open" }, { status: "review" });
  const db = await getDb();
  const pos = await getPosition(position.id);
  await db.update(positions).set({
    status: over.status ?? "review", triageScore: 3, triageVerdict: over.verdict ?? "pass", triageJson: {},
    triagedAt: new Date(Date.now() - (over.daysAgo ?? 1) * 86_400_000), listingStatus: over.listingStatus ?? "open",
    metadata: { ...(pos?.metadata || {}), ...(over.metadata || {}) },
  }).where(eq(positions.id, position.id));
  return position;
}

async function queuedFor(): Promise<string[]> {
  const rows = await (await getDb()).select().from(jobs).where(eq(jobs.type, "triage"));
  return rows.map((j) => String((j.payload as { positionId?: string }).positionId));
}

describe("stale-triage sweep", () => {
  beforeAll(async () => {
    delete process.env.DATABASE_URL;
    process.env.PGLITE_DATA_DIR = dir;
    coreEnv.openaiApiKey = "test-only";
    await bootstrap({ seedBoards: false });
  });
  beforeEach(async () => {
    const db = await getDb();
    await db.delete(jobs);
    await db.update(positions).set({ status: "archived" });
    await updateSettings({ triage: { staleSweepEnabled: true, staleSweepMaxRows: 20 }, llm: { operations: { triage: { enabled: true, model: "test-model", dailyCap: 0 } } } });
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => { await closeDb(); rmSync(dir, { recursive: true, force: true }); });

  it("queues the oldest stale active rows of any verdict, capped, and never archived, closed, hot or quarantined rows", async () => {
    const llm = vi.spyOn(getLlmClient(), "chatJson");
    const newest = await stale({ daysAgo: 1 });
    const oldFail = await stale({ daysAgo: 30, verdict: "fail" });
    const mid = await stale({ daysAgo: 10, status: "triaged", verdict: "marginal" });
    const archived = await stale({ daysAgo: 90, status: "archived" });
    const closed = await stale({ daysAgo: 90, listingStatus: "closed" });
    const hot = await stale({ daysAgo: 90, status: "applied" });
    const quarantined = await stale({ daysAgo: 90, metadata: { quarantined: true } });
    await updateSettings({ triage: { staleSweepMaxRows: 2 } });

    const first = await sweepStaleTriage();
    expect(first).toMatchObject({ enqueued: 2, selected: 2, stale: 3 });
    expect(first.skipped).toBeUndefined();
    expect(await queuedFor()).toEqual(expect.arrayContaining([oldFail.id, mid.id]));
    expect((await queuedFor()).length).toBe(2);
    const queued = await (await getDb()).select().from(jobs).where(eq(jobs.type, "triage"));
    expect(queued.every((j) => (j.payload as { refreshOnly?: boolean }).refreshOnly === true)).toBe(true);

    // A row with a triage job from the last day is not picked again: the next run moves on.
    const second = await sweepStaleTriage();
    expect(second).toMatchObject({ enqueued: 1, selected: 1 });
    const all = await queuedFor();
    expect(all).toContain(newest.id);
    for (const p of [archived, closed, hot, quarantined]) expect(all).not.toContain(p.id);
    expect(await sweepStaleTriage()).toMatchObject({ enqueued: 0, selected: 0 });
    expect(llm).not.toHaveBeenCalled();
  });

  it("does nothing when disabled or while the provider is down", async () => {
    await stale({ daysAgo: 5 });
    await updateSettings({ triage: { staleSweepEnabled: false } });
    expect(await sweepStaleTriage()).toMatchObject({ skipped: "disabled", enqueued: 0 });
    await updateSettings({ triage: { staleSweepEnabled: true } });
    const health = await llmHealth.getLlmHealth({ fresh: true });
    vi.spyOn(llmHealth, "getLlmHealth").mockResolvedValue({ ...health, providerDown: true });
    expect(await sweepStaleTriage()).toMatchObject({ skipped: "provider_down", enqueued: 0 });
    expect(await queuedFor()).toEqual([]);
  });

  it("uses at most half of the daily triage cap left after today's runs and queued jobs", async () => {
    for (let i = 0; i < 5; i++) await stale({ daysAgo: 5 + i });
    const db = await getDb();
    await db.insert(llmRuns).values({ id: newId("llm"), operation: "triage", model: "test-model" } as never);
    await updateSettings({ llm: { operations: { triage: { dailyCap: 6 } } } });
    // (6 - 1 run) / 2 => 2
    expect(await sweepStaleTriage()).toMatchObject({ enqueued: 2 });
    // (6 - 1 run - 2 queued) / 2 => 1
    expect(await sweepStaleTriage()).toMatchObject({ enqueued: 1 });
    // (6 - 1 - 3) / 2 => 1
    expect(await sweepStaleTriage()).toMatchObject({ enqueued: 1 });
    // (6 - 1 - 4) / 2 => 0
    expect(await sweepStaleTriage()).toMatchObject({ skipped: "daily_cap", enqueued: 0 });
    await updateSettings({ llm: { operations: { triage: { dailyCap: 1 } } } });
    expect((await sweepStaleTriage()).skipped).toMatch(/^triage_unavailable/);
  });

  it("clears a changed badge that no material revision backs and keeps a genuine one", async () => {
    const db = await getDb();
    const phantom = await stale({ status: "applied" });
    const genuine = await stale({ status: "applied" });
    await db.update(positions).set({ listingStatus: "changed" }).where(eq(positions.id, phantom.id));
    await db.update(positions).set({ listingStatus: "changed" }).where(eq(positions.id, genuine.id));
    await db.insert(jdRevisions).values({ id: newId("jdr"), positionId: genuine.id, revision: 2, contentHash: "synthetic-hash", changeKind: "material", material: true,
      title: "Platform Engineer", descriptionText: "Operate Kubernetes.",
      fieldDiffs: [{ path: "salary_raw", before: "USD 100000", after: "USD 150000" }] } as never);
    const r = await sweepStaleTriage();
    expect(r.changedBadgesCleared).toBe(1);
    expect((await getPosition(phantom.id))?.listingStatus).toBe("open");
    expect((await getPosition(genuine.id))?.listingStatus).toBe("changed");
  });
});
