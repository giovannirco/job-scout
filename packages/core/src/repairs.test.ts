import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { closeDb, getDb, positions, profiles } from "@job-scout/db";
import { bootstrap } from "./bootstrap.js";
import { runDataRepairs, type RepairStep } from "./repairs.js";
import { getProfile, updateProfile } from "./profile.js";
import { getSettings } from "./settings.js";
import { upsertFromJob } from "./positions.js";

const dir = mkdtempSync(join(tmpdir(), "job-scout-repairs-"));

describe("explicit data repairs", () => {
  beforeAll(async () => {
    if (process.env.REPAIR_TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.REPAIR_TEST_DATABASE_URL;
    else delete process.env.DATABASE_URL;
    process.env.PGLITE_DATA_DIR = dir;
    const opened = await Promise.all([getDb(), getDb(), getDb()]);
    expect(opened.every(db => db === opened[0])).toBe(true);
    await bootstrap({ seedBoards: false });
  });
  afterAll(async () => { await closeDb(); rmSync(dir, { recursive: true, force: true }); });

  it("previews real row changes without persisting data or version markers", async () => {
    const original = await getProfile();
    const steps: RepairStep[] = [{ name: "preview-name", version: "1", run: async () => {
      await updateProfile({ displayName: "Preview operator" });
      return { updated: 1 };
    } }];
    const report = await runDataRepairs("preview", steps);
    expect(report.outcome).toBe("previewed");
    expect(report.steps[0]?.changes).toContainEqual(expect.objectContaining({
      table: "profiles", id: original.id, operation: "update",
      before: expect.objectContaining({ displayName: original.displayName }),
      after: expect.objectContaining({ displayName: "Preview operator" }),
    }));
    expect((await getProfile()).displayName).toBe(original.displayName);
    expect((await getSettings()).repairVersions["preview-name"]).toBeUndefined();
  });

  it("rolls back all steps on a partial failure and reports failing row identifiers", async () => {
    const original = await getProfile();
    const report = await runDataRepairs("apply", [
      { name: "first", version: "1", run: async () => updateProfile({ displayName: "Must roll back" }) },
      { name: "partial", version: "1", run: async () => ({ failed: 1, failedIds: [original.id] }) },
      { name: "not-run", version: "1", run: async () => { throw new Error("must not execute"); } },
    ]);
    expect(report.outcome).toBe("failed");
    expect(report.steps.map(s => s.status)).toEqual(["ok", "failed", "pending"]);
    expect(report.steps[1]?.result).toMatchObject({ failedIds: [original.id] });
    expect((await getProfile()).displayName).toBe(original.displayName);
    expect((await getSettings()).repairVersions.first).toBeUndefined();
  });

  it("commits data and markers together and skips an already applied step", async () => {
    const run = vi.fn(async () => updateProfile({ displayName: "Applied operator" }));
    const plan = [{ name: "apply-name", version: "1", run }];
    expect((await runDataRepairs("apply", plan)).outcome).toBe("applied");
    expect((await getProfile()).displayName).toBe("Applied operator");
    const again = await runDataRepairs("apply", plan);
    expect(again.steps[0]?.status).toBe("skipped");
    expect(again.steps[0]?.changes).toEqual([]);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("previews and applies the complete registry, then skips every completed repair", async () => {
    const report = await runDataRepairs("preview");
    expect(report.outcome).toBe("previewed");
    expect(report.steps.every(s => s.status === "ok")).toBe(true);
    expect((await getSettings()).repairVersions["board-catalog"]).toBeUndefined();
    expect((await runDataRepairs("apply")).outcome).toBe("applied");
    const again = await runDataRepairs("apply");
    expect(again.outcome).toBe("applied");
    expect(again.steps.every(s => s.status === "skipped" && s.changes.length === 0)).toBe(true);
  });

  it("normal boots never archive identical postings, alter existing profiles, or fetch ATS data", async () => {
    const base = { provider: "greenhouse" as const, company: "Synthetic", title: "Software Engineer", descriptionText: "Identical job text", locationRaw: "Remote", listingStatus: "open" as const };
    const a = await upsertFromJob({ ...base, jobId: "one", externalIdentity: "greenhouse:synthetic:one", url: "https://boards.greenhouse.io/synthetic/jobs/1001" });
    const b = await upsertFromJob({ ...base, jobId: "two", externalIdentity: "greenhouse:synthetic:two", url: "https://boards.greenhouse.io/synthetic/jobs/1002" });
    expect(a.position.id).not.toBe(b.position.id);
    const db = await getDb();
    const before = await db.select().from(positions);
    const profile = await db.select().from(profiles);
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("startup must not fetch"));
    try {
      await bootstrap();
      await bootstrap();
      expect(fetch).not.toHaveBeenCalled();
      expect(await db.select().from(positions)).toEqual(before);
      expect(await db.select().from(profiles)).toEqual(profile);
    } finally { fetch.mockRestore(); }
    expect((await db.select().from(positions).where(eq(positions.id, b.position.id)))[0]?.status).toBe("triaged");
  });
});

it("selects explicit repairs in canonical order and rejects unknown or empty names", async () => {
  const { selectRepairSteps } = await import("./repairs.js");
  const plan: RepairStep[] = ["local", "remote", "labels"].map(name => ({ name, version: "1", run: async () => null }));
  expect(selectRepairSteps(plan, ["labels", "local", "labels"]).map(s => s.name)).toEqual(["local", "labels"]);
  expect(() => selectRepairSteps(plan, ["loacl"])).toThrow("Unknown");
  expect(() => selectRepairSteps(plan, [])).toThrow("empty");
  expect(() => selectRepairSteps(plan, ["local", ""])).toThrow("empty");
});
