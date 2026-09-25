import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { applicationMaterials, closeDb, decisionRuns, getDb, jobs, positions } from "@job-scout/db";
import type { AtsJob } from "@job-scout/ats";
import { bootstrap } from "./bootstrap.js";
import { updateSettings } from "./settings.js";
import { decisionContext, jevStatus, previewDecision, rankReviewQueue, runDecision, verificationFor } from "./decisions.js";
import { getPosition, patchPosition, upsertFromJob } from "./positions.js";
import { updateProfile } from "./profile.js";
import { runTriage } from "./triage.js";
import { getEvaluation, runEvaluate } from "./evaluate.js";
import { getCurrentMaterial, runMaterials, saveMaterial } from "./materials.js";
import { coreEnv } from "./env.js";
import { getLlmClient } from "./llm.js";

const dir = mkdtempSync(join(tmpdir(), "job-scout-decisions-"));
const savedKey = process.env.OPENROUTER_API_KEY;
const role = (suffix: string): AtsJob => ({ provider: "unknown", company: `Example ${suffix}`, title: "Senior Platform Engineer", url: `https://jobs.example/${suffix}`, locationRaw: "Remote worldwide", descriptionText: "Build Kubernetes infrastructure. Remote worldwide. Experience with Kubernetes required.", listingStatus: "open" });
const match = {
  model: "typesafe/jev-1.13-20260917", usage: { input_tokens: 400, output_tokens: 100, cost: 0.0000168 }, answers: {
    route: { type: "choice", choice: "shortlist", confidence: 1, probabilities: { shortlist: 1, review: 0, mismatch: 0 } },
    role: { type: "score", score: 4, confidence: 1, probabilities: { "0": 0, "1": 0, "2": 0, "3": 0, "4": 1 } },
    skills: { type: "score", score: 4, confidence: 1, probabilities: { "0": 0, "1": 0, "2": 0, "3": 0, "4": 1 } },
    seniority: { type: "score", score: 4, confidence: 1, probabilities: { "0": 0, "1": 0, "2": 0, "3": 0, "4": 1 } },
    eligible: { type: "noul", noul: 1 }, requirements: { type: "noul", noul: 1 },
  },
};
const unsupported = { ...match, answers: { supported: { type: "noul", noul: 0.01 }, grounded: { type: "noul", noul: 1 }, outcome: { type: "choice", choice: "revise", confidence: 1, probabilities: { supported: 0, review: 0, revise: 1 } } } };
const triage = { data: { score: 4, archetype: 4, comp: 4, location: 4, cvMatch: 4, hardDq: [], softFlags: [], archetypeLabel: "platform", compNote: "not stated", locationNote: "remote", oneLiner: "Relevant experience" }, model: "test-model", tokensIn: 1, tokensOut: 1, latencyMs: 1 };

describe("Jev workflows on isolated PGlite", () => {
  beforeAll(async () => {
    delete process.env.DATABASE_URL; process.env.PGLITE_DATA_DIR = dir; process.env.OPENROUTER_API_KEY = "test-only"; coreEnv.openaiApiKey = "test-only";
    await bootstrap({ seedBoards: false });
    await updateProfile({ location: "Canada", targetRoles: ["Platform Engineer"], masterResumeMarkdown: "Senior platform engineer operating Kubernetes.", scoutBrief: "Remote platform engineering roles." });
  });
  beforeEach(async () => {
    const db = await getDb(); await db.delete(decisionRuns);
    await updateSettings({ jev: { enabled: true, triage: "observe", verification: "observe", dailyCalls: 100, cacheMinutes: 60, maxStateChars: 20000 }, notifications: { enabled: false }, autopilot: { preset: "manual", triageNew: false, evaluate: { mode: "off" }, companyResearch: { mode: "off" }, suggestStatus: false, materials: { mode: "off" } }, llm: { operations: { triage: { enabled: true, model: "test-model", dailyCap: 0 }, evaluate: { enabled: true, model: "test-model", dailyCap: 0 }, materials: { enabled: true, model: "test-model", dailyCap: 0 } } } });
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  afterAll(async () => { if (savedKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = savedKey; await closeDb(); rmSync(dir, { recursive: true, force: true }); });

  it("reuses only the same input, rubric and settings, without storing source text", async () => {
    const fetcher = vi.fn().mockImplementation(async () => Response.json(match)); vi.stubGlobal("fetch", fetcher);
    const first = await runDecision({ recipe: "ranking", state: { candidateEvidence: "Private synthetic evidence", listing: "Kubernetes" } });
    const second = await runDecision({ recipe: "ranking", state: { candidateEvidence: "Private synthetic evidence", listing: "Kubernetes" } });
    expect(second.id).toBe(first.id); expect(second.cached).toBe(true); expect(fetcher).toHaveBeenCalledTimes(1);
    await runDecision({ recipe: "ranking", state: { candidateEvidence: "Changed evidence", listing: "Kubernetes" } });
    expect(fetcher).toHaveBeenCalledTimes(2);
    await updateSettings({ jev: { minConfidence: 0.99 } });
    await runDecision({ recipe: "ranking", state: { candidateEvidence: "Private synthetic evidence", listing: "Kubernetes" } });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(await (await getDb()).select().from(decisionRuns))).not.toContain("Private synthetic evidence");
  });
  it("reserves the daily budget atomically across overlapping calls", async () => {
    await updateSettings({ jev: { dailyCalls: 1 } });
    const fetcher = vi.fn().mockImplementation(async () => { await new Promise(resolve => setTimeout(resolve, 30)); return Response.json(match); }); vi.stubGlobal("fetch", fetcher);
    const outcomes = await Promise.allSettled([runDecision({ recipe: "ranking", state: "first" }), runDecision({ recipe: "ranking", state: "second" })]);
    expect(outcomes.filter(r => r.status === "fulfilled")).toHaveLength(1); expect(fetcher).toHaveBeenCalledTimes(1);
    expect((await jevStatus()).today.calls).toBe(1);
  });
  it("does not send oversized inputs or make calls while disabled", async () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    await expect(runDecision({ recipe: "ranking", state: "x".repeat(50000) })).rejects.toThrow("context limit");
    await updateSettings({ jev: { enabled: false } });
    await expect(runDecision({ recipe: "ranking", state: "test" })).rejects.toThrow("Enable Jev"); expect(fetcher).not.toHaveBeenCalled();
  });
  it("sends complete evidence when a larger input limit is explicitly saved", async () => {
    await updateSettings({ jev: { maxStateChars: 60000 } });
    const state = { candidateEvidence: "Synthetic skills evidence. ".repeat(1800), listing: "Remote platform role" };
    expect(JSON.stringify(state).length).toBeGreaterThan(40000);
    const fetcher = vi.fn().mockImplementation(async () => Response.json(match));
    vi.stubGlobal("fetch", fetcher);
    expect((await runDecision({ recipe: "triage", state })).status).toBe("ok");
    expect(JSON.parse(fetcher.mock.calls[0][1].body).state).toEqual(state);
  });
  it("records a provider failure without exposing its body", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("Private provider body", { status: 429 })));
    const run = await runDecision({ recipe: "ranking", state: "test" });
    expect(run.status).toBe("error"); expect(run.error).toContain("rate limiting"); expect(JSON.stringify(run)).not.toContain("Private provider body");
  });
  it("previews use current profile evidence and leave the position unchanged", async () => {
    const { position } = await upsertFromJob(role("preview"));
    const before = await getPosition(position.id);
    const fetcher = vi.fn().mockImplementation(async () => Response.json(match)); vi.stubGlobal("fetch", fetcher);
    await previewDecision("triage", position.id);
    expect(await getPosition(position.id)).toEqual(before);
    const state = JSON.parse(fetcher.mock.calls[0][1].body).state;
    expect(state.candidateEvidence).toContain("Kubernetes");
    expect((await decisionContext(position.id)).state).toEqual(state);
  });
  it("observes a match without replacing the normal triage call", async () => {
    const { position } = await upsertFromJob(role("observe")); vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(match)));
    const normal = vi.spyOn(getLlmClient(), "chatJson").mockResolvedValue(triage as never);
    expect(await runTriage(position.id)).toMatchObject({ model: "test-model" }); expect(normal).toHaveBeenCalledTimes(1);
  });
  it("uses clear matches and falls back on uncertainty", async () => {
    await updateSettings({ jev: { triage: "apply" } });
    const { position } = await upsertFromJob(role("fast")); vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(match)));
    const normal = vi.spyOn(getLlmClient(), "chatJson").mockResolvedValue(triage as never);
    expect(await runTriage(position.id)).toMatchObject({ model: "typesafe/jev-1.13-20260917", verdict: "pass" }); expect(normal).not.toHaveBeenCalled();
    const uncertain = structuredClone(match); uncertain.answers.eligible.noul = 0.5;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(uncertain)));
    const other = await upsertFromJob(role("uncertain"));
    expect(await runTriage(other.position.id)).toMatchObject({ model: "test-model" }); expect(normal).toHaveBeenCalledTimes(1);
  });
  it("does not overwrite an operator change during a Jev request", async () => {
    await updateSettings({ jev: { triage: "apply" } }); const { position } = await upsertFromJob(role("changed"));
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => { await patchPosition(position.id, { status: "applied" }); return Response.json(match); }));
    expect(await runTriage(position.id)).toMatchObject({ skipped: true, reason: "position_changed" });
    expect((await getPosition(position.id))?.status).toBe("applied");
  });
  it("holds evaluation follow-ups while preserving the report", async () => {
    await updateSettings({ jev: { verification: "apply" }, autopilot: { preset: "autopilot", suggestStatus: true, materials: { mode: "threshold", minEvaluateScore: 3 } } });
    const { position } = await upsertFromJob(role("evaluation")); vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(unsupported)));
    vi.spyOn(getLlmClient(), "chatDocument").mockResolvedValue({ data: { score: 4.5, verdict: "apply", headline: "Relevant" }, markdown: "Unsupported claim", model: "test-model", tokensIn: 1, tokensOut: 1, latencyMs: 1 } as never);
    expect(await runEvaluate(position.id)).toMatchObject({ autopilotSkipped: "jev_review_required" });
    expect((await getEvaluation(position.id, "evaluate"))?.markdown).toBe("Unsupported claim");
    expect((await (await getDb()).select().from(jobs)).filter(j => j.payload?.positionId === position.id)).toEqual([]);
  });
  it("keeps uncertain materials pending and does not advance the position", async () => {
    await updateSettings({ jev: { verification: "apply" } }); const { position } = await upsertFromJob(role("materials"));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(unsupported)));
    vi.spyOn(getLlmClient(), "chatDocument").mockResolvedValue({ data: { resumeSurface: "platform", notes: "Review draft", keywordsCovered: [], keywordsMissing: [] }, sections: { resume: "Unsupported résumé", cover: "Draft cover" }, markdown: "Draft", model: "test-model", tokensIn: 1, tokensOut: 1, latencyMs: 1 } as never);
    await runMaterials(position.id);
    expect((await getCurrentMaterial(position.id, "resume"))?.status).toBe("pending");
    expect((await getCurrentMaterial(position.id, "resume"))?.bodyMarkdown).toBe("Unsupported résumé");
    expect((await getPosition(position.id))?.status).toBe("triaged");
  });
  it("keeps a human revision current when materials finish late", async () => {
    const { position } = await upsertFromJob(role("materials-edited"));
    let humanId = "";
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => {
      humanId = (await saveMaterial({ positionId: position.id, kind: "resume", bodyMarkdown: "Human revision", source: "human" })).id;
      await patchPosition(position.id, { status: "applied" });
      return Response.json(unsupported);
    }));
    vi.spyOn(getLlmClient(), "chatDocument").mockResolvedValue({ data: { resumeSurface: "platform", notes: "Draft", keywordsCovered: [], keywordsMissing: [] }, sections: { resume: "Older generated version", cover: "Older cover" }, markdown: "Draft", model: "test-model", tokensIn: 1, tokensOut: 1, latencyMs: 1 } as never);
    const result = await runMaterials(position.id, { auto: true });
    expect(result.staleAtCompletion).toBe(true);
    expect((await getCurrentMaterial(position.id, "resume"))?.id).toBe(humanId);
    expect((await getPosition(position.id))?.status).toBe("applied");
    const old = (await (await getDb()).select().from(applicationMaterials).where(eq(applicationMaterials.id, result.resumeId)))[0];
    expect(old).toMatchObject({ isCurrent: false, status: "pending", bodyMarkdown: "Older generated version" });
  });
  it("puts eligible matches ahead of high-scoring mismatches and omits changed positions", async () => {
    await (await getDb()).update(positions).set({ status: "archived" });
    const good = (await upsertFromJob(role("rank-good"))).position;
    const mismatch = (await upsertFromJob(role("rank-mismatch"))).position;
    const changed = (await upsertFromJob(role("rank-changed"))).position;
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (_url, init) => {
      const state = JSON.parse(init.body).state;
      if (state.listing.company === "Example rank-changed") await patchPosition(changed.id, { status: "applied" });
      const result = structuredClone(match);
      if (state.listing.company === "Example rank-mismatch") {
        result.answers.route = { type: "choice", choice: "mismatch", confidence: 1, probabilities: { shortlist: 0, review: 0, mismatch: 1 } };
        result.answers.eligible.noul = 0;
      } else {
        result.answers.role.score = 3;
        result.answers.role.probabilities = { "0": 0, "1": 0, "2": 0, "3": 1, "4": 0 };
      }
      return Response.json(result);
    }));
    const result = await rankReviewQueue();
    expect(result.rows.map(r => r.positionId)).toEqual([good.id, mismatch.id]);
    expect(result.rows[0].run?.summary?.score).toBeLessThan(result.rows[1].run?.summary?.score ?? 0);
  });
  it("holds follow-ups if apply mode was enabled during an observe check", async () => {
    const { position } = await upsertFromJob(role("settings-changed"));
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => { await updateSettings({ jev: { verification: "apply" } }); return Response.json(unsupported); }));
    expect(await verificationFor({ recipe: "evaluation_check", positionId: position.id, candidateEvidence: "evidence", listing: "listing", draft: "draft" })).toMatchObject({ accepted: false, hold: true });
  });
  it("holds checks when the provider is down, but observe mode only records the failure", async () => {
    const { position } = await upsertFromJob(role("outage"));
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => new Response("down", { status: 503 })));
    const input = { recipe: "evaluation_check" as const, positionId: position.id, candidateEvidence: "evidence", listing: "listing", draft: "draft" };
    expect(await verificationFor(input)).toMatchObject({ hold: false, accepted: false });
    await updateSettings({ jev: { verification: "apply" } });
    expect(await verificationFor(input)).toMatchObject({ hold: true, accepted: false });
  });
});
