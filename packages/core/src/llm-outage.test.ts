import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, inArray } from "drizzle-orm";
import { closeDb, getDb, jobs } from "@job-scout/db";
import { LlmError } from "@job-scout/llm";
import { bootstrap } from "./bootstrap.js";
import { coreEnv } from "./env.js";
import { getLlmClient, retryFailedLlm } from "./llm.js";
import { checkLlmHealthAlerts, getLlmHealth, publicLlmHealth } from "./llm-health.js";
import { upsertFromJob } from "./positions.js";
import { updateSettings } from "./settings.js";
import { enqueueJob } from "./jobs.js";
import { runTriage } from "./triage.js";
import { registry } from "./metrics.js";
import { resetWahaSender, setWahaSender } from "./waha.js";
import { startWorker } from "../../../apps/worker/src/loop.js";

const dir = mkdtempSync(join(tmpdir(), "job-scout-llm-outage-"));
const scored = { data: { score: 2.5, hardDq: [], oneLiner: "Synthetic fit" }, model: "test-model", tokensIn: 10, tokensOut: 5, latencyMs: 5 };
const sent: string[] = [];

async function position(name: string) {
  return (await upsertFromJob({ provider: "unknown", company: "Example Outage Co", title: `Platform Engineer ${name}`, url: `https://jobs.example/outage/${name}`, listingStatus: "open", descriptionText: "Operate Kubernetes." })).position;
}

describe("LLM outage handling", () => {
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

  it("parks triage while the provider is down, alerts once, and recovers", async () => {
    const db = await getDb();
    const ps = await Promise.all(["a", "b", "c", "d"].map(position));
    const model = vi.spyOn(getLlmClient(), "chatJson").mockRejectedValue(new LlmError("llm 402 on /chat/completions: insufficient balance", 402, "insufficient balance"));
    const queued: string[] = [];
    for (const p of ps) queued.push((await enqueueJob("triage", { positionId: p.id }, { dedupeKey: `triage:${p.id}`, priority: 20 })).id);
    const rows = async () => db.select().from(jobs).where(inArray(jobs.id, queued));

    const worker = startWorker({ scheduler: false, pollMs: 10, concurrency: 1, types: ["triage"], llmHealthEveryMs: 3_600_000 });
    try {
      await vi.waitFor(async () => expect((await rows()).every((j) => j.status === "queued" && j.attempts <= 1 && j.runAfter.getTime() > Date.now())).toBe(true), { timeout: 20_000 });
      await vi.waitFor(async () => expect((await rows()).filter((j) => j.payload?.llmParked)).toHaveLength(2), { timeout: 20_000 });
    } finally {
      await worker.stop();
    }
    // Three real calls detect the outage; the fourth job is parked without calling the provider.
    expect(model).toHaveBeenCalledTimes(3);
    const all = await rows();
    expect(all.some((j) => j.status === "failed")).toBe(false);
    const parked = all.filter((j) => j.payload?.llmParked);
    expect(parked.every((j) => j.attempts === 0)).toBe(true);
    expect(parked[0]!.payload?.llmParked).toMatchObject({ kind: "quota" });

    const health = await getLlmHealth({ fresh: true });
    expect(health).toMatchObject({ state: "failing", providerDown: true, kind: "quota", failingOperations: ["triage"] });
    const pub = publicLlmHealth(health);
    expect(JSON.stringify(pub)).not.toContain("insufficient balance");
    expect(await registry.getSingleMetricAsString("job_scout_llm_provider_down")).toContain('kind="quota"} 1');

    // Alert once on the transition to failing, then stay quiet.
    expect(await checkLlmHealthAlerts()).toMatchObject({ alert: "outage", providerDown: true });
    expect(await checkLlmHealthAlerts()).toMatchObject({ alert: null });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("LLM calls failing (quota)");
    expect(sent[0]).toContain("triage");

    // A successful probe flips health back; the recovery alert releases parked jobs once.
    vi.restoreAllMocks();
    vi.spyOn(getLlmClient(), "chatJson").mockResolvedValue(scored as never);
    const probe = await position("probe");
    expect(await runTriage(probe.id)).toMatchObject({ skipped: false, score: 2.5 });
    const rec = await checkLlmHealthAlerts();
    expect(rec).toMatchObject({ alert: "recovered", providerDown: false, released: 2 });
    expect(await checkLlmHealthAlerts()).toMatchObject({ alert: null, released: 0 });
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain("LLM calls recovered");
    const afterRelease = await rows();
    expect(afterRelease.filter((j) => j.payload?.llmParked)).toHaveLength(0);

    // retry_failed_llm pulls the backed-off jobs forward instead of waiting out their delay.
    const retry = await retryFailedLlm({ operations: ["triage"] });
    expect(retry.released).toBeGreaterThanOrEqual(2);
    expect((await rows()).every((j) => j.runAfter.getTime() <= Date.now())).toBe(true);

    const worker2 = startWorker({ scheduler: false, pollMs: 10, concurrency: 1, types: ["triage"], llmHealthEveryMs: 3_600_000 });
    try {
      await vi.waitFor(async () => expect((await rows()).every((j) => j.status === "succeeded")).toBe(true), { timeout: 20_000 });
    } finally {
      await worker2.stop();
    }
    const first = (await db.select().from(jobs).where(eq(jobs.id, queued[0]!)))[0]!;
    expect(first.attempts).toBeLessThanOrEqual(2);
  });
});
