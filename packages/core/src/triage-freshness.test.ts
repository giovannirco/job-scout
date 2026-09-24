import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { closeDb, getDb, jobs, positions } from "@job-scout/db";
import { bootstrap } from "./bootstrap.js";
import { coreEnv } from "./env.js";
import { getLlmClient } from "./llm.js";
import { getPosition, getPositionDetail, patchPosition, upsertFromJob } from "./positions.js";
import { getProfile, profileFingerprint, updateProfile } from "./profile.js";
import { updateSettings } from "./settings.js";
import { runTriage } from "./triage.js";
import { refreshStaleTriage } from "./triage-refresh.js";
import { processJob } from "../../../apps/worker/src/loop.js";
import * as autopilot from "./autopilot.js";
import * as notify from "./notify.js";
import { createThread, runChatTurn } from "./chat.js";

const dir = mkdtempSync(join(tmpdir(), "job-scout-triage-freshness-"));
const result = { data: { score: 4.2, hardDq: [], oneLiner: "Fits the current profile" }, model: "test-model", tokensIn: 1, tokensOut: 1, latencyMs: 1 };
async function stale(name: string, status: "triaged" | "review" = "review") {
  const { position } = await upsertFromJob({ provider: "greenhouse", boardToken: name, jobId: "1", company: name,
    title: "Platform Engineer", url: `https://boards.greenhouse.io/${name}/jobs/1`, locationRaw: "Remote",
    descriptionText: "Operate Kubernetes infrastructure.", listingStatus: "open" }, { status });
  await (await getDb()).update(positions).set({ triageScore: 4.7, triageVerdict: "pass", triagedAt: new Date(), triageJson: {} }).where(eq(positions.id, position.id));
  return position;
}

describe("triage freshness", () => {
  beforeAll(async () => {
    delete process.env.DATABASE_URL;
    process.env.PGLITE_DATA_DIR = dir;
    coreEnv.openaiApiKey = "test-only";
    await bootstrap({ seedBoards: false });
    await updateSettings({ llm: { operations: { triage: { enabled: true, model: "test-model", dailyCap: 0 } } } });
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => { await closeDb(); rmSync(dir, { recursive: true, force: true }); });

  it("refreshes legacy scores without force and uses resume, location and targeting in the prompt", async () => {
    const p = await stale("legacy-score");
    await updateProfile({ scoutBrief: "Earlier generic brief", location: "Canada", targetRoles: ["Platform Engineer"],
      masterResumeMarkdown: "Built a production control plane", identityMarkdown: "Infrastructure specialist", cashFloorUsd: 120000 });
    const llm = vi.spyOn(getLlmClient(), "chatJson").mockResolvedValue(result as never);
    const auto = vi.spyOn(autopilot, "afterTriage"); const notification = vi.spyOn(notify, "emitNotify");
    expect(await runTriage(p.id, { refreshOnly: true })).toMatchObject({ skipped: false, score: 4.2 });
    const prompt = JSON.stringify(llm.mock.calls[0][0].messages);
    for (const text of ["Built a production control plane", "Canada", "Platform Engineer", "120000"]) expect(prompt).toContain(text);
    expect((await getPositionDetail(p.id))?.triageStale).toBe(false);
    expect(await runTriage(p.id, { refreshOnly: true })).toMatchObject({ skipped: true });
    expect(llm).toHaveBeenCalledTimes(1);
    expect(auto).not.toHaveBeenCalled(); expect(notification).not.toHaveBeenCalled();
    await updateProfile({ email: "new@acme.test" });
    expect((await getPositionDetail(p.id))?.triageStale).toBe(false);
    await updateProfile({ location: "Germany" });
    expect((await getPositionDetail(p.id))?.triageStale).toBe(true);
    await runTriage(p.id, { refreshOnly: true });
    expect(llm).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(llm.mock.calls[1][0].messages)).toContain("Germany");
  });

  it("exposes stale scores to the chat model instead of dropping their freshness", async () => {
    const p = await stale("chat-stale");
    await updateSettings({ chat: { browserTools: false, writeTools: false }, llm: { operations: { chat: { enabled: true, model: "test-model", dailyCap: 0 } } } });
    const args = { company: "chat-stale" };
    const llm = vi.spyOn(getLlmClient(), "chatStream")
      .mockResolvedValueOnce({ content: "", model: "test-model", tokensIn: 1, tokensOut: 1, latencyMs: 1,
        toolCalls: [{ id: "read", name: "search_positions", arguments: JSON.stringify(args), args }] } as never)
      .mockResolvedValueOnce({ content: "The score needs refresh.", model: "test-model", tokensIn: 1, tokensOut: 1, latencyMs: 1, toolCalls: [] } as never);
    const thread = await createThread({ scope: "global" });
    await runChatTurn(thread.id, "Check this candidate", () => {});
    const tool = llm.mock.calls[1][0].messages.find(m => m.role === "tool");
    expect(JSON.parse(tool!.content!).items[0]).toMatchObject({ slug: p.slug, triageStale: true });
  });

  it("keeps an in-flight profile change visible as stale", async () => {
    const p = await stale("profile-inflight");
    const before = profileFingerprint(await getProfile());
    vi.spyOn(getLlmClient(), "chatJson").mockImplementation(async () => {
      await updateProfile({ masterResumeMarkdown: "New production experience while scoring" });
      return result as never;
    });
    await runTriage(p.id, { refreshOnly: true });
    expect((await getPosition(p.id))?.triageJson?.profileHash).toBe(before);
    expect((await getPositionDetail(p.id))?.triageStale).toBe(true);
  });

  it("preserves an unreviewed stage when the refreshed score fails", async () => {
    const p = await stale("refresh-fail", "triaged");
    vi.spyOn(getLlmClient(), "chatJson").mockResolvedValue({ ...result, data: { ...result.data, score: 1.5, hardDq: ["Ineligible location"] } } as never);
    await runTriage(p.id, { refreshOnly: true });
    expect(await getPosition(p.id)).toMatchObject({ status: "triaged", triageVerdict: "fail" });
  });

  it("previews, bounds and deduplicates the refresh queue, and rechecks eligibility in the worker", async () => {
    const p = await stale("refresh-queue");
    const db = await getDb();
    // Keep this test's candidates independent of previous score tests.
    await db.update(positions).set({ status: "archived" });
    await patchPosition(p.id, { status: "review" });
    const closed = await stale("refresh-closed");
    await db.update(positions).set({ listingStatus: "closed" }).where(eq(positions.id, closed.id));
    const applied = await stale("refresh-applied"); await patchPosition(applied.id, { status: "applied" });
    expect(await refreshStaleTriage()).toMatchObject({ dryRun: true, selected: 1, enqueued: 0 });
    expect(await db.select().from(jobs)).toHaveLength(0);
    await expect(refreshStaleTriage({ limit: 26 })).rejects.toThrow();
    const first = await refreshStaleTriage({ dryRun: false, limit: 1 });
    expect(first).toMatchObject({ selected: 1, enqueued: 1, deduped: 0 });
    expect(await refreshStaleTriage({ dryRun: false })).toMatchObject({ enqueued: 0, deduped: 1 });
    const queued = (await db.select().from(jobs))[0];
    expect(queued.payload).toMatchObject({ refreshOnly: true, positionId: p.id });
    await patchPosition(p.id, { status: "applied" });
    const llm = vi.spyOn(getLlmClient(), "chatJson");
    expect(await processJob(queued)).toMatchObject({ skipped: true, reason: "position_no_longer_eligible" });
    expect(llm).not.toHaveBeenCalled();
    await patchPosition(p.id, { status: "review" });
    const auto = vi.spyOn(autopilot, "afterTriage");
    vi.spyOn(getLlmClient(), "chatJson").mockResolvedValue(result as never);
    expect(await processJob(queued)).toMatchObject({ skipped: false });
    expect(auto).not.toHaveBeenCalled();
    expect((await getPositionDetail(p.id))?.triageStale).toBe(false);
  });
});
