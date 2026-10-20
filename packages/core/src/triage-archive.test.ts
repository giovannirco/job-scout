import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { closeDb, getDb, positions, timelineEvents } from "@job-scout/db";
import { bootstrap } from "./bootstrap.js";
import { coreEnv } from "./env.js";
import { getLlmClient } from "./llm.js";
import { archivePosition, getPosition, patchPosition, upsertFromJob } from "./positions.js";
import { updateProfile } from "./profile.js";
import { updateSettings } from "./settings.js";
import { runTriage } from "./triage.js";
import { repairTriageArchives } from "./triage-archive-repair.js";

const dir = mkdtempSync(join(tmpdir(), "job-scout-triage-archive-"));
const fail = (hardDq: string[], score = 2.4) => ({
  data: { score, archetype: 3, comp: 4, location: 4, cvMatch: 2, hardDq, softFlags: [], archetypeLabel: "platform", compNote: "not stated", locationNote: "remote", oneLiner: "Low fit" },
  model: "test-model", tokensIn: 1, tokensOut: 1, latencyMs: 1,
});
async function position(name: string, salaryRaw?: string) {
  const { position } = await upsertFromJob({ provider: "greenhouse", boardToken: name, jobId: "1", company: name,
    title: "Senior DevOps Engineer", url: `https://boards.greenhouse.io/${name}/jobs/1`, locationRaw: "Remote",
    descriptionText: "Operate Kubernetes and Terraform for an example product.", salaryRaw, listingStatus: "open" }, { status: "triaged" });
  return position;
}

describe("triage auto-archive policy", () => {
  beforeAll(async () => {
    delete process.env.DATABASE_URL;
    process.env.PGLITE_DATA_DIR = dir;
    coreEnv.openaiApiKey = "test-only";
    await bootstrap({ seedBoards: false });
    await updateSettings({ llm: { operations: { triage: { enabled: true, model: "test-model", dailyCap: 0 } } } });
    await updateProfile({ cashFloorUsd: 100000 });
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => { await closeDb(); rmSync(dir, { recursive: true, force: true }); });

  it("a skill-gap FAIL stays active with its score", async () => {
    const p = await position("skill-gap");
    vi.spyOn(getLlmClient(), "chatJson").mockResolvedValue(fail(["Required landing-zone ownership not claimed"]) as never);
    expect(await runTriage(p.id, { force: true })).toMatchObject({ verdict: "fail", score: 2.4 });
    const after = (await getPosition(p.id))!;
    expect(after.status).toBe("triaged");
    expect(after.archiveReason).toBeNull();
    expect(after.triageScore).toBe(2.4);
    expect((after.triageJson as { archive?: unknown }).archive).toEqual({ archived: false, why: "no_hard_disqualifier" });
  });

  it("a low score without any hard disqualifier stays active", async () => {
    const p = await position("low-score");
    vi.spyOn(getLlmClient(), "chatJson").mockResolvedValue(fail([], 1.8) as never);
    await runTriage(p.id, { force: true });
    expect((await getPosition(p.id))!.status).toBe("triaged");
  });

  it("marginal verdicts are never archived, even with keepMarginal=false", async () => {
    await updateSettings({ triage: { keepMarginal: false } });
    const p = await position("marginal");
    vi.spyOn(getLlmClient(), "chatJson").mockResolvedValue(fail([], 3.2) as never);
    expect(await runTriage(p.id, { force: true })).toMatchObject({ verdict: "marginal" });
    expect((await getPosition(p.id))!.status).toBe("triaged");
    await updateSettings({ triage: { keepMarginal: true } });
  });

  it.each([
    ["onsite", ["On-site in Austin with no remote path"], undefined, "workplace"],
    ["citizenship", ["Requires US citizenship"], undefined, "work_authorization"],
    ["residency", ["Must reside in the United States"], undefined, "residency"],
    ["low-pay", ["Compensation below floor"], "$50k - $60k", "pay"],
  ])("hard disqualifier %s archives", async (name, hardDq, salary, kind) => {
    const p = await position(`hard-${name}`, salary);
    vi.spyOn(getLlmClient(), "chatJson").mockResolvedValue(fail(hardDq) as never);
    await runTriage(p.id, { force: true });
    const after = (await getPosition(p.id))!;
    expect(after.status).toBe("archived");
    expect(after.archiveReason).toContain(`${kind}: ${hardDq[0]}`);
    const db = await getDb();
    const moves = await db.select().from(timelineEvents).where(and(eq(timelineEvents.positionId, p.id), eq(timelineEvents.kind, "status")));
    expect(moves).toEqual([expect.objectContaining({ title: "triaged → archived", actor: "triage", body: after.archiveReason })]);
  });

  it("a manually restored skill-gap FAIL stays active and writes no status event", async () => {
    const p = await position("restored-skill-gap");
    await archivePosition(p.id, "triage fail 2.4: required GPU serving stack not claimed", "system");
    await patchPosition(p.id, { status: "triaged" }, "manual");
    vi.spyOn(getLlmClient(), "chatJson").mockResolvedValue(fail(["Required production GPU serving stack not claimed"]) as never);
    await runTriage(p.id, { force: true });
    expect((await getPosition(p.id))!.status).toBe("triaged");
    const db = await getDb();
    const moves = await db.select().from(timelineEvents).where(and(eq(timelineEvents.positionId, p.id), eq(timelineEvents.kind, "status")));
    expect(moves.map((m) => m.title).sort()).toEqual(["archived → triaged", "archived: triage fail 2.4: required GPU serving stack not claimed"]);
  });

  it("a pay disqualifier with posted pay above the floor stays active", async () => {
    const p = await position("pay-ok", "$120k - $150k");
    vi.spyOn(getLlmClient(), "chatJson").mockResolvedValue(fail(["Compensation below floor"]) as never);
    await runTriage(p.id, { force: true });
    expect((await getPosition(p.id))!.status).toBe("triaged");
  });

  it("autopilot never re-archives a position a person restored", async () => {
    const p = await position("restored");
    await archivePosition(p.id, "triage fail 2.0: On-site", "system");
    await patchPosition(p.id, { status: "triaged" }, "career-agent");
    vi.spyOn(getLlmClient(), "chatJson").mockResolvedValue(fail(["On-site in Austin with no remote path"]) as never);
    await runTriage(p.id, { force: true });
    const after = (await getPosition(p.id))!;
    expect(after.status).toBe("triaged");
    expect((after.triageJson as { archive?: { why?: string; restoredBy?: string } }).archive).toMatchObject({ archived: false, why: "human_restored", restoredBy: "career-agent" });
  });

  it("a restore by the app itself does not block archiving", async () => {
    const p = await position("system-restore");
    await archivePosition(p.id, "listing_closed", "system");
    await patchPosition(p.id, { status: "triaged" }, "system");
    vi.spyOn(getLlmClient(), "chatJson").mockResolvedValue(fail(["On-site in Austin with no remote path"]) as never);
    await runTriage(p.id, { force: true });
    expect((await getPosition(p.id))!.status).toBe("archived");
  });

  it("repair lists soft triage archives, is dry-run by default, restores with the score kept on --apply", async () => {
    const db = await getDb();
    const soft = await position("repair-soft");
    const hard = await position("repair-hard");
    const marginal = await position("repair-marginal");
    const old = await position("repair-old");
    const now = new Date();
    const set = (id: string, reason: string, hardDq: string[], triagedAt = now) =>
      db.update(positions).set({ status: "archived", archiveReason: reason, triageScore: 2.5, triageVerdict: "fail", triagedAt, triageJson: { hardDq } }).where(eq(positions.id, id));
    await set(soft.id, "triage fail 2.5: Required Kafka not claimed", ["Required Kafka not claimed"]);
    await set(hard.id, "triage fail 2.5: Hybrid in Lisbon", ["Hybrid in Lisbon"]);
    await set(marginal.id, "triage marginal 3.1", []);
    await set(old.id, "triage fail 2.5: Required Kafka not claimed", ["Required Kafka not claimed"], new Date(now.getTime() - 60 * 86_400_000));

    const dry = await repairTriageArchives({ days: 30 });
    expect(dry.dryRun).toBe(true);
    const byId = Object.fromEntries(dry.rows.map((r) => [r.id, r.action]));
    expect(byId[soft.id]).toBe("restore");
    expect(byId[marginal.id]).toBe("restore");
    expect(byId[hard.id]).toBe("keep_archived");
    expect(byId[old.id]).toBeUndefined();
    expect((await getPosition(soft.id))!.status).toBe("archived");

    await repairTriageArchives({ days: 30, apply: true });
    const restored = (await getPosition(soft.id))!;
    expect(restored.status).toBe("triaged");
    expect(restored.archiveReason).toBeNull();
    expect(restored.triageScore).toBe(2.5);
    expect(restored.triageVerdict).toBe("fail");
    expect((await getPosition(hard.id))!.status).toBe("archived");
    expect((await getPosition(old.id))!.status).toBe("archived");
  });
});
