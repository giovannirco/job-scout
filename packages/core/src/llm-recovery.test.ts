import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, inArray, sql } from "drizzle-orm";
import { closeDb, getDb, id, jobs, llmRuns } from "@job-scout/db";
import { bootstrap } from "./bootstrap.js";
import { coreEnv } from "./env.js";
import { getLlmClient } from "./llm.js";
import { checkLlmHealthAlerts, getLlmHealth } from "./llm-health.js";
import { upsertFromJob } from "./positions.js";
import { updateSettings } from "./settings.js";
import { enqueueJob } from "./jobs.js";
import { resetWahaSender, setWahaSender } from "./waha.js";
import { startWorker } from "../../../apps/worker/src/loop.js";

/** Synthetic role detail: enough JD to score (see jdSufficiency). */
const DUTIES = " You will own CI/CD pipelines, on-call rotations, incident reviews, capacity planning and cost reports. We expect solid Linux, networking and scripting skills, clear written communication, and care for reliable, observable services that teams can trust.";

const dir = mkdtempSync(join(tmpdir(), "job-scout-llm-recovery-"));
const scored = { data: { score: 2.5, hardDq: [], oneLiner: "Synthetic fit" }, model: "test-model", tokensIn: 10, tokensOut: 5, latencyMs: 5 };
const sent: string[] = [];

async function position(name: string) {
  return (await upsertFromJob({ provider: "unknown", company: "Example Recovery Co", title: `Platform Engineer ${name}`, url: `https://jobs.example/recovery/${name}`, listingStatus: "open", descriptionText: "Operate Kubernetes." + DUTIES })).position;
}

describe("LLM recovery seen through another operation", () => {
  beforeAll(async () => {
    delete process.env.DATABASE_URL;
    process.env.PGLITE_DATA_DIR = dir;
    coreEnv.openaiApiKey = "test-only";
    await bootstrap({ seedBoards: false });
    await updateSettings({
      notifications: { enabled: true, quietHours: { enabled: false }, channels: { desk: { enabled: true, chatId: "111111000000000009@g.us" } } },
      autopilot: { preset: "manual", triageNew: false },
      llm: { operations: { triage: { enabled: true, model: "test-model", dailyCap: 0 } } },
      jev: { enabled: false },
    });
    setWahaSender({
      configured: true,
      session: "default",
      async sendText(_chatId, body) {
        sent.push(body);
        return { ok: true, providerRef: `ref-${sent.length}` };
      },
      async listMessages() {
        return [];
      },
    });
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    resetWahaSender();
    await closeDb();
    rmSync(dir, { recursive: true, force: true });
  });

  it("a success of another operation clears providerDown, releases parked jobs and alerts recovery once", async () => {
    const db = await getDb();
    // A short provider-wide blip: three company_research calls fail fast in a row.
    const t0 = Date.now();
    await db.insert(llmRuns).values([3, 2, 1].map((s) => ({
      id: id("llm"),
      operation: "company_research" as const,
      model: "test-model",
      status: "error",
      error: "llm 503 on /chat/completions: service unavailable",
      latencyMs: 300,
      createdAt: new Date(t0 - s * 1_000),
    })));
    const down = await getLlmHealth({ fresh: true });
    expect(down).toMatchObject({ state: "failing", providerDown: true, kind: "outage", failingOperations: ["company_research"] });
    expect(await checkLlmHealthAlerts()).toMatchObject({ alert: "outage", providerDown: true });
    expect(sent).toHaveLength(1);

    // One triage job was parked by the outage; a fresh one arrives and goes through as the probe.
    const [pa, pb] = await Promise.all(["a", "b"].map(position));
    const parked = await enqueueJob("triage", { positionId: pa!.id }, { dedupeKey: `triage:${pa!.id}`, priority: 20 });
    await db
      .update(jobs)
      .set({ runAfter: new Date(Date.now() + 15 * 60_000), payload: sql`${jobs.payload} || ${JSON.stringify({ llmParked: { kind: "outage", at: new Date().toISOString(), count: 1 } })}::jsonb` })
      .where(eq(jobs.id, parked.id));
    const fresh = await enqueueJob("triage", { positionId: pb!.id }, { dedupeKey: `triage:${pb!.id}`, priority: 20 });
    const ids = [parked.id, fresh.id];
    const rows = async () => db.select().from(jobs).where(inArray(jobs.id, ids));
    expect((await rows()).find((j) => j.id === parked.id)?.payload?.llmParked).toBeTruthy();

    const model = vi.spyOn(getLlmClient(), "chatJson").mockResolvedValue(scored as never);
    // The worker's own health tick is far away: only the probe's success can release the parked job.
    const worker = startWorker({ scheduler: false, pollMs: 10, concurrency: 1, types: ["triage"], llmHealthEveryMs: 3_600_000 });
    try {
      await vi.waitFor(async () => expect((await rows()).every((j) => j.status === "succeeded")).toBe(true), { timeout: 10_000 });
    } finally {
      await worker.stop();
    }
    expect(model).toHaveBeenCalledTimes(2);
    expect((await rows()).some((j) => j.payload?.llmParked)).toBe(false);

    // company_research has not succeeded itself yet: degraded, but no longer parking everything.
    const health = await getLlmHealth({ fresh: true });
    expect(health).toMatchObject({ state: "degraded", providerDown: false, failingOperations: [], degradedOperations: ["company_research"] });

    // Recovery is announced exactly once.
    expect(await checkLlmHealthAlerts()).toMatchObject({ alert: "recovered", providerDown: false, released: 0 });
    expect(await checkLlmHealthAlerts()).toMatchObject({ alert: null });
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain("LLM calls recovered");
  });
});
