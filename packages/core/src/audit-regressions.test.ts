import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { closeDb, getDb, positions, evaluations, boardSources, discoveryFeed } from "@job-scout/db";
import { bootstrap } from "./bootstrap.js";
import { applySnapshot, getPosition, patchPosition, upsertFromJob } from "./positions.js";
import { afterTriage, afterEvaluate, createApproval, resolveApproval } from "./autopilot.js";
import { updateSettings } from "./settings.js";
import { coreEnv } from "./env.js";
import { getLlmClient } from "./llm.js";
import { runListingClassify } from "./listing-classify.js";
import { scanBoard } from "./scan.js";
import { createThread, runChatTurn } from "./chat.js";
import type { AtsJob } from "@job-scout/ats";

const dir = mkdtempSync(join(tmpdir(), "job-scout-audit-"));
const job = (name: string, over: Partial<AtsJob> = {}): AtsJob => ({ provider: "greenhouse", company: name, title: "Senior Platform Engineer", url: `https://boards.greenhouse.io/${name}/jobs/12345`, locationRaw: "Remote", descriptionText: "Operate Kubernetes infrastructure. ".repeat(20), listingStatus: "open", ...over });

describe("live-audit regressions on isolated PGlite", () => {
  beforeAll(async () => {
    delete process.env.DATABASE_URL;
    process.env.PGLITE_DATA_DIR = dir;
    coreEnv.openaiApiKey = "test-only";
    await bootstrap({ seedBoards: false });
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  afterAll(async () => { await closeDb(); rmSync(dir, { recursive: true, force: true }); });

  it.each(["archived", "skip", "applied", "interview", "materials"] as const)("expires stale promotion after operator moved to %s", async status => {
    const { position } = await upsertFromJob(job(`stale-${status}`), { status: "review" });
    const approval = (await createApproval({ kind: "status_suggestion", positionId: position.id, title: "Apply", payload: { toStatus: "materials" } }))!;
    await patchPosition(position.id, { status });
    expect(await resolveApproval(approval.id, "approved")).toMatchObject({ status: "expired", applied: false });
    expect((await getPosition(position.id))?.status).toBe(status);
    expect(await resolveApproval(approval.id, "approved")).toMatchObject({ status: "expired", applied: false });
  });

  it("approves a current suggestion exactly once and keeps timeline history", async () => {
    const { position } = await upsertFromJob(job("current-approval"), { status: "review" });
    const approval = (await createApproval({ kind: "status_suggestion", positionId: position.id, title: "Apply", payload: { toStatus: "materials" } }))!;
    expect(await resolveApproval(approval.id, "approved")).toMatchObject({ status: "approved", applied: true });
    expect((await getPosition(position.id))?.status).toBe("materials");
    expect(await resolveApproval(approval.id, "approved")).toMatchObject({ applied: false });
  });

  it("expires closed listings and suggestions from superseded evaluations", async () => {
    const { position } = await upsertFromJob(job("stale-eval"), { status: "review" });
    const db = await getDb();
    await db.insert(evaluations).values({ id: "ev_new", positionId: position.id, kind: "evaluate" });
    const approval = (await createApproval({ kind: "archive_suggestion", positionId: position.id, title: "Skip", payload: { evaluationId: "ev_old" } }))!;
    expect(await resolveApproval(approval.id, "approved")).toMatchObject({ status: "expired", staleReason: "evaluation_superseded" });
    const closed = (await createApproval({ kind: "status_suggestion", positionId: position.id, title: "Apply", payload: { toStatus: "materials" } }))!;
    await db.update(positions).set({ listingStatus: "closed" }).where(eq(positions.id, position.id));
    expect(await resolveApproval(closed.id, "approved")).toMatchObject({ status: "expired", staleReason: "listing_closed" });
    expect((await getPosition(position.id))?.status).toBe("review");
  });

  it("does not launch pre-application work for terminal or applied positions", async () => {
    const { position } = await upsertFromJob(job("hooks"), { status: "applied" });
    expect(await afterTriage({ positionId: position.id, companyId: position.company.id, status: "applied", score: 4.5, verdict: "pass" })).toEqual({});
    expect(await afterEvaluate({ positionId: position.id, companyId: position.company.id, status: "skip", score: 4.5, verdict: "apply", headline: "old", evaluationId: "ev_unused" })).toEqual({});
  });

  it("reuses classification only for identical inputs, and skips empty/terminal work", async () => {
    await updateSettings({ llm: { operations: { listing_classify: { enabled: true, model: "test-model", dailyCap: 0 } } } });
    const llm = vi.spyOn(getLlmClient(), "chatJson").mockResolvedValue({ data: { workplace: "remote", geoClass: "hard_geo", evidence: "US residents only" }, content: "{}", model: "test-model", tokensIn: 1, tokensOut: 1, latencyMs: 1 } as never);
    const j = job("classifier-cache");
    const { position } = await upsertFromJob(j);
    await runListingClassify(position.id);
    expect(llm).toHaveBeenCalledTimes(1);
    // Polling updates fetchedAt; that bookkeeping must not invalidate model input.
    const db = await getDb();
    const beforePoll = (await getPosition(position.id))!;
    await db.update(positions).set({ metadata: { ...beforePoll.metadata, ats: { ...(beforePoll.metadata?.ats as object), fetchedAt: "2000-01-01T00:00:00Z" } } }).where(eq(positions.id, position.id));
    await applySnapshot({ positionId: position.id, job: j });
    expect((await getPosition(position.id))?.geoClass).toBe("hard_geo");
    expect(await runListingClassify(position.id)).toMatchObject({ skipped: true, reason: "unchanged_input" });
    await applySnapshot({ positionId: position.id, job: { ...j, descriptionText: j.descriptionText + " Additional requirements." } });
    await runListingClassify(position.id);
    expect(llm).toHaveBeenCalledTimes(2);
    await patchPosition(position.id, { status: "skip" });
    expect(await runListingClassify(position.id)).toMatchObject({ skipped: true, reason: "inactive" });
    const empty = await upsertFromJob(job("empty-jd", { descriptionText: "" }));
    expect(await runListingClassify(empty.position.id)).toMatchObject({ skipped: true, reason: "missing_jd" });
    expect(llm).toHaveBeenCalledTimes(2);
  });

  it("keeps old postings still listed on a live board and rejects junk titles", async () => {
    await updateSettings({ gate: { titleInclude: ["engineer"], titleExclude: [], maxPostingAgeDays: 14, allowUnknownGeo: true } });
    const db = await getDb();
    await db.insert(boardSources).values({ id: "brd_age", company: "Age test", provider: "ashby", token: "age-test" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ jobs: [
      { id: "old", title: "Platform Engineer", publishedAt: "2020-01-01", jobUrl: "https://jobs.ashbyhq.com/age-test/old" },
      { id: "junk", title: "", jobUrl: "https://jobs.ashbyhq.com/age-test/junk" },
    ] }), { status: 200 })));
    expect(await scanBoard("brd_age")).toMatchObject({ total: 2, seen: 2, passed: 1, filtered: 1, created: 1 });
    const feed = await db.select().from(discoveryFeed).where(eq(discoveryFeed.boardSourceId, "brd_age"));
    expect(feed.find(r => r.title === "Platform Engineer")).toMatchObject({ lane: "passed", postedAt: new Date("2020-01-01") });
    expect(feed.find(r => r.title === "")?.gateReason).toBe("junk_title");
    await scanBoard("brd_age");
    expect((await db.select().from(discoveryFeed).where(eq(discoveryFeed.boardSourceId, "brd_age")))).toHaveLength(2);
  });

  it("checks the daily cap between chat model steps", async () => {
    await updateSettings({ chat: { browserTools: false, writeTools: false, maxSteps: 3 }, llm: { operations: { chat: { enabled: true, model: "test-model", dailyCap: 1 } } } });
    const llm = vi.spyOn(getLlmClient(), "chatStream").mockResolvedValue({ content: "", model: "test-model", tokensIn: 1, tokensOut: 1, latencyMs: 1, toolCalls: [{ id: "call-read", name: "search_positions", arguments: "{}", args: {} }] } as never);
    const thread = await createThread({ scope: "global" });
    const events: string[] = [];
    await runChatTurn(thread.id, "Read my queue", event => { if (event.type === "error") events.push(event.message); });
    expect(llm).toHaveBeenCalledTimes(1);
    expect(events.join(" ")).toContain("daily cap");
  });

  it("cancellation after a model reply stops its pending write tool", async () => {
    await updateSettings({ chat: { browserTools: false, writeTools: true }, llm: { operations: { chat: { dailyCap: 0 } } } });
    const { position } = await upsertFromJob(job("cancelled-chat"), { status: "review" });
    const args = { slug: position.slug, status: "archived" };
    vi.spyOn(getLlmClient(), "chatStream").mockResolvedValue({ content: "", model: "test-model", tokensIn: 1, tokensOut: 1, latencyMs: 1, toolCalls: [{ id: "call-write", name: "set_position_status", arguments: JSON.stringify(args), args }] } as never);
    const thread = await createThread({ scope: "global" });
    const controller = new AbortController();
    const toolCalls: string[] = [];
    await runChatTurn(thread.id, "Stop", event => {
      if (event.type === "message") controller.abort();
      if (event.type === "tool_call") toolCalls.push(event.name);
    }, { signal: controller.signal });
    expect(toolCalls).toEqual([]);
    expect((await getPosition(position.id))?.status).toBe("review");
  });
});
