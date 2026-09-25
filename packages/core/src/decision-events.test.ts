import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, decisionRuns, getDb, jobs } from "@job-scout/db";
import type { AtsJob } from "@job-scout/ats";
import { bootstrap } from "./bootstrap.js";
import { updateSettings } from "./settings.js";
import { updateProfile } from "./profile.js";
import { applySnapshot, getPosition, patchPosition, upsertFromJob } from "./positions.js";
import { enqueuePositionDecision } from "./decision-events.js";
import { previewDecision } from "./decisions.js";
import { processJob } from "../../../apps/worker/src/loop.js";
import { coreEnv } from "./env.js";
import { getLlmClient } from "./llm.js";
import { runTriage } from "./triage.js";

const dir = mkdtempSync(join(tmpdir(), "job-scout-decision-events-"));
const savedKey = process.env.OPENROUTER_API_KEY;
const role = (name: string): AtsJob => ({ provider: "unknown", company: "Example Systems", title: "Senior Platform Engineer",
  url: `https://jobs.example/${name}`, locationRaw: "Remote worldwide", listingStatus: "open",
  descriptionText: "Build Kubernetes infrastructure and automate deployments with Terraform. Remote worldwide." });
const score = { type: "score", score: 4, confidence: 1, probabilities: { "0": 0, "1": 0, "2": 0, "3": 0, "4": 1 } };
const answer = { model: "typesafe/jev-1.13", usage: { input_tokens: 100, output_tokens: 20 }, answers: {
  route: { type: "choice", choice: "shortlist", confidence: 1, probabilities: { shortlist: 1, review: 0, mismatch: 0 } },
  role: score, skills: score, seniority: score, eligible: { type: "noul", noul: 1 }, requirements: { type: "noul", noul: 1 },
} };
async function checks() { return (await (await getDb()).select().from(jobs)).filter(j => j.type === "jev_check"); }

describe("automatic Jev checks", () => {
  beforeAll(async () => {
    delete process.env.DATABASE_URL; process.env.PGLITE_DATA_DIR = dir; process.env.OPENROUTER_API_KEY = "test-only";
    coreEnv.openaiApiKey = "test-only";
    await bootstrap({ seedBoards: false });
    await updateProfile({ location: "Canada", targetRoles: ["Platform Engineer"], masterResumeMarkdown: "Ten years operating Kubernetes and Terraform.", scoutBrief: "Remote platform work." });
  });
  beforeEach(async () => {
    const db = await getDb(); await db.delete(jobs); await db.delete(decisionRuns);
    await updateSettings({ jev: { enabled: true, triage: "observe", dailyCalls: 100, cacheMinutes: 60 },
      notifications: { enabled: false }, autopilot: { preset: "manual", triageNew: false, jdReview: { mode: "off" }, evaluate: { mode: "off" }, companyResearch: { mode: "off" }, materials: { mode: "off" } },
      llm: { operations: { triage: { enabled: true, model: "test-model", dailyCap: 0 } } } });
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  afterAll(async () => { if (savedKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = savedKey; await closeDb(); rmSync(dir, { recursive: true, force: true }); });

  it("checks a newly discovered JD against the current resume even with writing automation off", async () => {
    const job = role("new"); const { position } = await upsertFromJob(job);
    expect(await checks()).toHaveLength(1);
    const fetcher = vi.fn().mockImplementation(async () => Response.json(answer)); vi.stubGlobal("fetch", fetcher);
    await updateProfile({ masterResumeMarkdown: "Current resume: ten years operating Kubernetes and Terraform." });
    const before = await getPosition(position.id);
    const queued = (await checks())[0];
    expect(await processJob(queued)).toMatchObject({ status: "ok", revision: 1 });
    const state = JSON.parse(fetcher.mock.calls[0][1].body).state;
    expect(state.listing.description).toBe(job.descriptionText);
    expect(state.candidateEvidence).toContain("Current resume:");
    expect(await getPosition(position.id)).toEqual(before);
    expect(await enqueuePositionDecision(position.id, 1)).toMatchObject({ deduped: true });
  });

  it("checks material changes in an interview without advancing the stage, and skips older queued revisions", async () => {
    const job = role("changed"); const { position } = await upsertFromJob(job, { status: "interview" });
    const old = (await checks())[0];
    await applySnapshot({ positionId: position.id, job: { ...job, locationRaw: "Remote Canada only" }, source: "watch" });
    const rows = await checks(); expect(rows).toHaveLength(2);
    const fetcher = vi.fn().mockImplementation(async () => Response.json(answer)); vi.stubGlobal("fetch", fetcher);
    expect(await processJob(old)).toMatchObject({ skipped: "revision_superseded" });
    const current = rows.find(j => j.payload?.revision === 2)!;
    expect(await processJob(current)).toMatchObject({ status: "ok", revision: 2 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetcher.mock.calls[0][1].body).state.listing.location).toContain("Canada");
    expect((await getPosition(position.id))?.status).toBe("interview");
    await applySnapshot({ positionId: position.id, job: { ...job, locationRaw: "Remote Canada only" }, source: "watch" });
    expect(await checks()).toHaveLength(2);
  });

  it("rechecks closure, operator decisions and settings before calling the provider", async () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const { position } = await upsertFromJob(role("closed")); const queued = (await checks())[0];
    await applySnapshot({ positionId: position.id, job: { ...role("closed"), listingStatus: "closed" } });
    expect(await checks()).toHaveLength(1);
    expect(await processJob(queued)).toMatchObject({ skipped: "position_no_longer_eligible" });
    const next = await upsertFromJob(role("operator")); const pending = (await checks()).find(j => j.payload?.positionId === next.position.id)!;
    await patchPosition(next.position.id, { status: "rejected" });
    expect(await processJob(pending)).toMatchObject({ skipped: "position_no_longer_eligible" });
    await updateSettings({ jev: { triage: "off" } });
    expect(await processJob(pending)).toMatchObject({ skipped: "disabled" });
    await upsertFromJob(role("disabled")); expect(await checks()).toHaveLength(2);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not let a cosmetic revision cancel the pending check, and checks a JD that arrives later", async () => {
    const job = role("formatting");
    const { position } = await upsertFromJob({ ...job, descriptionText: `<p>${job.descriptionText}</p>` });
    const queued = (await checks())[0];
    expect(await applySnapshot({ positionId: position.id, job })).toMatchObject({ material: false });
    expect(await checks()).toHaveLength(1);
    const fetcher = vi.fn().mockImplementation(async () => Response.json(answer)); vi.stubGlobal("fetch", fetcher);
    expect(await processJob(queued)).toMatchObject({ status: "ok" });
    const emptyJob = role("late-description");
    const empty = await upsertFromJob({ ...emptyJob, descriptionText: "" });
    const emptyCheck = (await checks()).find(j => j.payload?.positionId === empty.position.id)!;
    expect(await processJob(emptyCheck)).toMatchObject({ skipped: "missing_description" });
    await applySnapshot({ positionId: empty.position.id, job: emptyJob });
    const filled = (await checks()).find(j => j.payload?.positionId === empty.position.id && j.payload?.revision === 2)!;
    expect(filled).toBeDefined();
    expect(await processJob(filled)).toMatchObject({ status: "ok" });
  });

  it("shares automatic results with normal triage without treating a manual preview as automatic activity", async () => {
    const { position } = await upsertFromJob(role("cached"));
    const fetcher = vi.fn().mockImplementation(async () => Response.json(answer)); vi.stubGlobal("fetch", fetcher);
    const preview = await previewDecision("triage", position.id);
    const automatic = await processJob((await checks())[0]);
    expect(automatic.decisionRunId).not.toBe(preview.id);
    expect(fetcher).toHaveBeenCalledTimes(2);
    vi.spyOn(getLlmClient(), "chatJson").mockResolvedValue({ data: { score: 4.5, hardDq: [], oneLiner: "Relevant" }, model: "test-model", tokensIn: 1, tokensOut: 1 } as never);
    await runTriage(position.id);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect((await getPosition(position.id))?.triageJson?.jev).toMatchObject({ runId: automatic.decisionRunId });
  });

  it("honors the Jev budget independently of writing-model limits", async () => {
    await updateSettings({ jev: { dailyCalls: 1 } });
    await upsertFromJob(role("budget-one")); await upsertFromJob(role("budget-two"));
    const fetcher = vi.fn().mockImplementation(async () => Response.json(answer)); vi.stubGlobal("fetch", fetcher);
    const [first, second] = await checks();
    expect(await processJob(first)).toMatchObject({ status: "ok" });
    expect(await processJob(second)).toMatchObject({ skipped: "daily_cap" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
