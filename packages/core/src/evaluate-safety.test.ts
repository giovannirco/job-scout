import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { closeDb, getDb, jobs, positions, timelineEvents } from "@job-scout/db";
import type { AtsJob } from "@job-scout/ats";
import { processJob } from "../../../apps/worker/src/loop.js";
import { bootstrap } from "./bootstrap.js";
import { archivePosition, getPosition, patchPosition, upsertFromJob } from "./positions.js";
import { afterEvaluate } from "./autopilot.js";
import { getEvaluation, runEvaluate } from "./evaluate.js";
import { enqueueJob } from "./jobs.js";
import { getProfile, updateProfile } from "./profile.js";
import { updateSettings } from "./settings.js";
import { coreEnv } from "./env.js";
import { getLlmClient } from "./llm.js";

const dir = mkdtempSync(join(tmpdir(), "job-scout-evaluate-safety-"));
const job = (name: string): AtsJob => ({ provider: "greenhouse", company: name, title: "Senior Platform Engineer", url: `https://boards.greenhouse.io/${name}/jobs/12345`, locationRaw: "Remote", descriptionText: "Operate Kubernetes infrastructure. ".repeat(20), listingStatus: "open" });
const result = { data: { score: 4.5, verdict: "apply", headline: "Good fit" }, markdown: "Evaluation report", model: "test-model", tokensIn: 1, tokensOut: 1, latencyMs: 1 };

describe("evaluation freshness on isolated PGlite", () => {
  beforeAll(async () => {
    delete process.env.DATABASE_URL;
    process.env.PGLITE_DATA_DIR = dir;
    coreEnv.openaiApiKey = "test-only";
    await bootstrap({ seedBoards: false });
    await updateSettings({ llm: { operations: { evaluate: { enabled: true, model: "test-model", dailyCap: 0 } } } });
  });
  afterEach(() => { vi.restoreAllMocks(); });
  afterAll(async () => { await closeDb(); rmSync(dir, { recursive: true, force: true }); });

  it.each(["archived", "skip", "applied", "interview", "materials"] as const)("worker skips queued auto evaluation after a move to %s", async status => {
    const { position } = await upsertFromJob(job(`queued-${status}`));
    const queued = await enqueueJob("evaluate", { positionId: position.id, auto: true });
    await patchPosition(position.id, { status });
    const llm = vi.spyOn(getLlmClient(), "chatDocument");
    const db = await getDb();
    const row = (await db.select().from(jobs).where(eq(jobs.id, queued.id)))[0]!;
    expect(await processJob(row)).toMatchObject({ skipped: true, reason: "position_no_longer_eligible" });
    expect(llm).not.toHaveBeenCalled();
    expect((await getPosition(position.id))?.status).toBe(status);
  });

  it.each(["archived", "skip", "applied", "interview", "materials"] as const)("keeps a report without undoing an in-flight move to %s", async status => {
    const { position } = await upsertFromJob(job(`inflight-${status}`));
    vi.spyOn(getLlmClient(), "chatDocument").mockImplementation(async () => {
      if (status === "archived") await archivePosition(position.id, "operator decision");
      else await patchPosition(position.id, { status });
      return result as never;
    });
    expect(await runEvaluate(position.id, { auto: true })).toMatchObject({ staleAtCompletion: true, autopilotSkipped: "evaluation_superseded" });
    const current = await getPosition(position.id);
    expect(current?.status).toBe(status);
    if (status === "archived") expect(current?.archiveReason).toBe("operator decision");
    expect((await getEvaluation(position.id, "evaluate"))?.json).toMatchObject({ staleAtCompletion: true });
    const db = await getDb();
    const queued = await db.select().from(jobs);
    expect(queued.filter(r => r.payload?.positionId === position.id)).toEqual([]);
  });

  it.each(["closed", "quarantined", "content"])("detects an in-flight %s change even without a status change", async change => {
    const { position } = await upsertFromJob(job(`inflight-${change}`));
    const db = await getDb();
    vi.spyOn(getLlmClient(), "chatDocument").mockImplementation(async () => {
      await db.update(positions).set(change === "closed" ? { listingStatus: "closed" } : change === "quarantined" ? { metadata: { quarantined: true } } : { contentHash: "new-content" }).where(eq(positions.id, position.id));
      return result as never;
    });
    expect(await runEvaluate(position.id)).toMatchObject({ staleAtCompletion: true, autopilotSkipped: "evaluation_superseded" });
    expect((await getPosition(position.id))?.status).toBe("triaged");
  });

  it("does not promote a report generated from a superseded profile", async () => {
    const { position } = await upsertFromJob(job("profile-change"));
    const original = await getProfile();
    vi.spyOn(getLlmClient(), "chatDocument").mockImplementation(async () => {
      await updateProfile({ scoutBrief: original.scoutBrief + " New target role." });
      return result as never;
    });
    expect(await runEvaluate(position.id)).toMatchObject({ staleAtCompletion: true, autopilotSkipped: "evaluation_superseded" });
    expect((await getPosition(position.id))?.status).toBe("triaged");
    await updateProfile({ scoutBrief: original.scoutBrief });
  });

  it("promotes an unchanged triaged position with a status timeline event", async () => {
    const { position } = await upsertFromJob(job("unchanged"));
    vi.spyOn(getLlmClient(), "chatDocument").mockResolvedValue(result as never);
    expect(await runEvaluate(position.id)).toMatchObject({ staleAtCompletion: false });
    expect((await getPosition(position.id))?.status).toBe("review");
    const db = await getDb();
    const events = await db.select().from(timelineEvents).where(eq(timelineEvents.positionId, position.id));
    expect(events.filter(e => e.kind === "status" && e.actor === "evaluate")).toHaveLength(1);
  });

  it("manual evaluation of an archive keeps the archive and reason", async () => {
    const { position } = await upsertFromJob(job("manual-archive"));
    await archivePosition(position.id, "not pursuing");
    vi.spyOn(getLlmClient(), "chatDocument").mockResolvedValue(result as never);
    expect(await runEvaluate(position.id)).toMatchObject({ staleAtCompletion: false });
    expect(await getPosition(position.id)).toMatchObject({ status: "archived", archiveReason: "not pursuing" });
  });

  it("rechecks freshness before the follow-up hook runs", async () => {
    const { position } = await upsertFromJob(job("hook-change"), { status: "review" });
    await patchPosition(position.id, { status: "applied" });
    expect(await afterEvaluate({ positionId: position.id, companyId: position.company.id, status: "review", expectedUpdatedAt: position.updatedAt.toISOString(), evaluationId: "unused", score: 4.5, verdict: "apply", headline: "old" })).toEqual({ autopilotSkipped: "position_changed" });
  });
});
