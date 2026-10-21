import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { closeDb, getDb, jobs, positions } from "@job-scout/db";
import { bootstrap } from "./bootstrap.js";
import { coreEnv } from "./env.js";
import { getLlmClient } from "./llm.js";
import { getPosition, upsertFromJob } from "./positions.js";
import { getProfile, profileFingerprint, updateProfile } from "./profile.js";
import { updateSettings } from "./settings.js";
import { runTriage } from "./triage.js";
import { retriageTimezoneFails } from "./retriage-timezone.js";

/** Synthetic role detail: enough JD to score (see jdSufficiency). */
const DUTIES = " You will own CI/CD pipelines, on-call rotations, incident reviews, capacity planning and cost reports. We expect solid Linux, networking and scripting skills, clear written communication, and care for reliable, observable services that teams can trust.";

const dir = mkdtempSync(join(tmpdir(), "job-scout-retriage-tz-"));
const out = (hardDq: string[], extra: Record<string, unknown> = {}) => ({
  data: { score: 2.4, archetype: 4.5, comp: 4, location: 1, cvMatch: 4, hardDq, softFlags: [], archetypeLabel: "platform", compNote: "not stated", locationNote: "US time zones", oneLiner: "Timezone mismatch", ...extra },
  model: "test-model", tokensIn: 1, tokensOut: 1, latencyMs: 1,
});
async function position(name: string) {
  const { position } = await upsertFromJob({ provider: "greenhouse", boardToken: name, jobId: "1", company: name,
    title: "Senior Platform Engineer", url: `https://boards.greenhouse.io/${name}/jobs/1`, locationRaw: "Remote",
    descriptionText: "Operate Kubernetes for an example product." + DUTIES, listingStatus: "open" }, { status: "triaged" });
  return position;
}

describe("timezone policy in triage and the re-triage repair", () => {
  beforeAll(async () => {
    delete process.env.DATABASE_URL;
    process.env.PGLITE_DATA_DIR = dir;
    coreEnv.openaiApiKey = "test-only";
    await bootstrap({ seedBoards: false });
    await updateSettings({ llm: { operations: { triage: { enabled: true, model: "test-model", dailyCap: 0 } } } });
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => { await closeDb(); rmSync(dir, { recursive: true, force: true }); });

  it("a timezone-only hardDq is dropped, the score recomputed and the change recorded", async () => {
    const p = await position("tz-only");
    vi.spyOn(getLlmClient(), "chatJson").mockResolvedValue(out(["Requires US time zones (EST hours)"]) as never);
    const r = await runTriage(p.id, { force: true });
    expect(r).toMatchObject({ skipped: false });
    const after = (await getPosition(p.id))!;
    expect(after.status).toBe("triaged");
    expect(after.triageVerdict).not.toBe("fail");
    expect(after.triageScore).toBeGreaterThan(3.5);
    const tj = after.triageJson as { hardDq: string[]; tzPolicy?: { removedHardDq: string[]; penalty: number; rawScore: number } };
    expect(tj.hardDq).toEqual([]);
    expect(tj.tzPolicy).toEqual({ removedHardDq: ["Requires US time zones (EST hours)"], penalty: 0, rawScore: 2.4 });
  });

  it("a residency hardDq still fails and archives", async () => {
    const p = await position("tz-residency");
    vi.spyOn(getLlmClient(), "chatJson").mockResolvedValue(out(["Must reside in the United States", "EST hours"]) as never);
    await runTriage(p.id, { force: true });
    const after = (await getPosition(p.id))!;
    expect(after.status).toBe("archived");
    expect(after.archiveReason).toContain("residency");
    expect((after.triageJson as { hardDq: string[] }).hardDq).toEqual(["Must reside in the United States"]);
  });

  it("the prompt says timezone only informs without a profile range and names the range when set", async () => {
    const p = await position("tz-prompt");
    const spy = vi.spyOn(getLlmClient(), "chatJson").mockResolvedValue(out([]) as never);
    const before = profileFingerprint(await getProfile());
    await runTriage(p.id, { force: true });
    const system = () => String((spy.mock.calls.at(-1)![0] as { messages: Array<{ content: string }> }).messages[0]!.content);
    expect(system()).toMatch(/set no timezone range/);
    await updateProfile({ metadata: { acceptableTzRange: { min: -5, max: 1 } } });
    expect(profileFingerprint(await getProfile())).not.toBe(before);
    await runTriage(p.id, { force: true });
    expect(system()).toContain("UTC-5..UTC+1");
    await updateProfile({ metadata: {} });
    expect(profileFingerprint(await getProfile())).toBe(before);
  });

  it("re-triage plans timezone fails only, dry-run by default, and revives triage archives on --apply", async () => {
    const db = await getDb();
    const tz = await position("old-tz-archive");
    const res = await position("old-residency-archive");
    const operator = await position("operator-archive");
    await db.update(positions).set({ status: "archived", triageVerdict: "fail", triageScore: 2.1, archiveReason: "triage fail 2.1: requires overlap with US time zones", triageJson: { hardDq: ["requires overlap with US time zones"] } }).where(eq(positions.id, tz.id));
    await db.update(positions).set({ status: "archived", triageVerdict: "fail", triageScore: 2.0, archiveReason: "triage fail 2.0: residency: Must reside in Canada", triageJson: { hardDq: ["Must reside in Canada"] } }).where(eq(positions.id, res.id));
    await db.update(positions).set({ status: "archived", archiveReason: "not interested, EST hours" }).where(eq(positions.id, operator.id));

    const dry = await retriageTimezoneFails();
    expect(dry.dryRun).toBe(true);
    const ids = dry.plan.map((r) => r.id);
    expect(ids).toContain(tz.id);
    expect(ids).not.toContain(res.id);
    expect(ids).not.toContain(operator.id);
    expect(dry.plan.find((r) => r.id === tz.id)).toMatchObject({ revive: true, timezoneOnly: true });
    expect((await getPosition(tz.id))!.status).toBe("archived");

    const forced = await retriageTimezoneFails({ include: [operator.id, "pos_missing"] });
    expect(forced.plan.find((r) => r.id === operator.id)).toMatchObject({ forced: true, revive: false });
    expect(forced.missing).toEqual(["pos_missing"]);

    const applied = await retriageTimezoneFails({ apply: true });
    expect(applied.dryRun).toBe(false);
    const revived = (await getPosition(tz.id))!;
    expect(revived.status).toBe("triaged");
    expect(revived.archiveReason).toBeNull();
    expect((await getPosition(res.id))!.status).toBe("archived");
    const queued = (await db.select().from(jobs).where(and(eq(jobs.type, "triage"), eq(jobs.status, "queued")))).filter((j) => j.payload?.positionId === tz.id);
    expect(queued).toHaveLength(1);
    expect(queued[0]!.payload).toMatchObject({ positionId: tz.id, force: true });
  });
});
