import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { closeDb, getDb, timelineEvents } from "@job-scout/db";
import { buildTriageMessages, buildEvaluateMessages } from "@job-scout/llm";
import { bootstrap } from "./bootstrap.js";
import { coreEnv } from "./env.js";
import { getLlmClient } from "./llm.js";
import { getPosition, patchPosition, stampCareerOps, upsertFromJob } from "./positions.js";
import { updateProfile } from "./profile.js";
import { updateSettings } from "./settings.js";
import { runTriage } from "./triage.js";
import { careerOpsDropStatus, mapCareerOpsStatus, setStatusFromCaller } from "./career-ops-status.js";
import { listCareerOpsSkips } from "./triage-archive-repair.js";

const dir = mkdtempSync(join(tmpdir(), "job-scout-career-ops-status-"));
async function position(name: string, status: "triaged" | "review" | "materials" = "review", salaryRaw?: string) {
  const { position } = await upsertFromJob({ provider: "greenhouse", boardToken: name, jobId: "1", company: name,
    title: "Platform Engineer", url: `https://boards.greenhouse.io/${name}/jobs/1`, locationRaw: "Remote",
    descriptionText: "Operate Kubernetes and Terraform for an example product.", salaryRaw, listingStatus: "open" }, { status });
  return position;
}
const notes = async (id: string) => (await (await getDb()).select().from(timelineEvents).where(eq(timelineEvents.positionId, id))).filter((e) => e.kind === "note");

describe("career-ops never skips or archives on its own", () => {
  beforeAll(async () => {
    delete process.env.DATABASE_URL;
    process.env.PGLITE_DATA_DIR = dir;
    coreEnv.openaiApiKey = "test-only";
    await bootstrap({ seedBoards: false });
    await updateSettings({ llm: { operations: { triage: { enabled: true, model: "test-model", dailyCap: 0 } } } });
    await updateProfile({ cashFloorUsd: 70000 });
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => { await closeDb(); rmSync(dir, { recursive: true, force: true }); });

  it("tracker drop labels do not map to a job-scout status", () => {
    for (const s of ["Discarded", "SKIP", "skip", "Skipped", "withdrawn", "SKIP-cash"]) {
      expect(mapCareerOpsStatus(s)).toBeNull();
      expect(careerOpsDropStatus(s)).toBe(true);
    }
    expect(mapCareerOpsStatus("Rejected")).toBe("rejected");
    expect(mapCareerOpsStatus("Applied")).toBe("applied");
    expect(careerOpsDropStatus("Applied")).toBe(false);
  });

  it("a career-ops sync skip is recorded as a note, not applied", async () => {
    const p = await position("tracker-discarded", "materials");
    await stampCareerOps(p.id, { trackerId: "1", status: "Discarded" });
    const r = await setStatusFromCaller(p.id, "skip", { actor: "sync-agent via token", note: "career-ops sync: tracker #1 is Discarded" });
    expect(r).toMatchObject({ status: "materials", statusApplied: false });
    expect((await getPosition(p.id))!.status).toBe("materials");
    expect((await notes(p.id)).some((e) => e.title.startsWith("career-ops says skip"))).toBe(true);
    const a = await setStatusFromCaller(p.id, "archived", { actor: "sync-agent", source: "career-ops", reason: "tracker Discarded" });
    expect(a).toMatchObject({ statusApplied: false });
    expect((await getPosition(p.id))!.status).toBe("materials");
  });

  it("other callers still set skip/archived, and career-ops still records real outcomes", async () => {
    const p = await position("operator-skip");
    expect(await setStatusFromCaller(p.id, "skip", { actor: "operator" })).toMatchObject({ status: "skip" });
    const q = await position("tracker-rejected");
    expect(await setStatusFromCaller(q.id, "rejected", { actor: "sync-agent", note: "career-ops sync: tracker #2 is Rejected" })).toMatchObject({ status: "rejected" });
  });

  it("a restore out of skip blocks triage auto-archive", async () => {
    const p = await position("skip-restored", "triaged");
    await patchPosition(p.id, { status: "skip" }, "sync-agent");
    await patchPosition(p.id, { status: "triaged" }, "career-agent");
    vi.spyOn(getLlmClient(), "chatJson").mockResolvedValue({ data: { score: 1.5, archetype: 3, comp: 4, location: 1, cvMatch: 3, hardDq: ["On-site in Austin with no remote path"], softFlags: [], archetypeLabel: "platform", compNote: "", locationNote: "", oneLiner: "x" }, model: "test-model", tokensIn: 1, tokensOut: 1, latencyMs: 1 } as never);
    await runTriage(p.id, { force: true });
    const after = (await getPosition(p.id))!;
    expect(after.status).toBe("triaged");
    expect((after.triageJson as { archive?: { why?: string } }).archive?.why).toBe("human_restored");
  });

  it("pay above the floor but below last cash never archives", async () => {
    const p = await position("band-below-last-cash", "triaged", "$80,000 - $120,000");
    vi.spyOn(getLlmClient(), "chatJson").mockResolvedValue({ data: { score: 2.5, archetype: 4, comp: 1, location: 5, cvMatch: 4, hardDq: ["Posted pay max $120k is below last cash and the ask"], softFlags: [], archetypeLabel: "platform", compNote: "", locationNote: "", oneLiner: "x" }, model: "test-model", tokensIn: 1, tokensOut: 1, latencyMs: 1 } as never);
    await runTriage(p.id, { force: true });
    const after = (await getPosition(p.id))!;
    expect(after.status).toBe("triaged");
    expect((after.triageJson as { archive?: { why?: string } }).archive?.why).toBe("pay_at_or_above_floor");
  });

  it("prompts make the cash floor the only pay disqualifier", () => {
    const t = JSON.stringify(buildTriageMessages({ title: "t", company: "c", jdText: "jd", brief: "b", jdMaxChars: 1000, passThreshold: 3.5, marginalThreshold: 3 }));
    expect(t).toContain("the profile cash floor is the only pay disqualifier");
    expect(t).toMatch(/Last\/current\/previous cash[^"]*never a hardDq/);
    const e = JSON.stringify(buildEvaluateMessages({ title: "t", company: "c", jdText: "jd", brief: "b", identityMarkdown: "", masterResumeMarkdown: "" }));
    expect(e).toContain("only posted pay under the profile cash floor justifies skip");
  });

  it("repair lists career-ops-driven skips without changing them", async () => {
    const p = await position("listed-skip", "materials");
    await stampCareerOps(p.id, { trackerId: "9", status: "Discarded" });
    await patchPosition(p.id, { status: "skip" }, "sync-agent");
    const rows = await listCareerOpsSkips(new Date(Date.now() - 30 * 86_400_000));
    expect(rows.find((r) => r.id === p.id)).toMatchObject({ trackerStatus: "Discarded", from: "materials", skippedBy: "sync-agent" });
    expect((await getPosition(p.id))!.status).toBe("skip");
  });
});
