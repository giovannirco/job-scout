import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, getDb, llmRuns } from "@job-scout/db";
import { eq } from "drizzle-orm";
import { LlmError } from "@job-scout/llm";
import { bootstrap } from "./bootstrap.js";
import { getLlmRun, listLlmRuns, logged, renderPrompt, LLM_TRANSCRIPT_MAX_CHARS } from "./llm.js";

const dir = mkdtempSync(join(tmpdir(), "job-scout-llmlog-"));
const result = (content: string) => ({ content, model: "test-model", tokensIn: 11, tokensOut: 7, latencyMs: 42 });

describe("llm transcript capture", () => {
  beforeAll(async () => {
    delete process.env.DATABASE_URL;
    process.env.PGLITE_DATA_DIR = dir;
    await bootstrap({ seedBoards: false });
  });
  afterAll(async () => { await closeDb(); rmSync(dir, { recursive: true, force: true }); });

  it("renders roles and bodies rather than raw JSON", () => {
    const r = renderPrompt([{ role: "system", content: "be brief" }, { role: "user", content: "why" }]);
    expect(r.text).toContain("### SYSTEM");
    expect(r.text).toContain("be brief");
    expect(r.text).toContain("### USER");
    expect(r.chars).toBe(r.text!.length);
  });

  it("tolerates agent messages whose content is null", () => {
    expect(renderPrompt([{ role: "assistant", content: null }]).text).toContain("### ASSISTANT");
  });

  it("stores what was asked and what came back, and serves it per run", async () => {
    const messages = [{ role: "system", content: "classify this posting" }, { role: "user", content: "Senior SRE, Brazil" }];
    await logged("triage", "test-model", null, async () => result("verdict: pass"), messages);

    const list = await listLlmRuns({ operation: "triage" });
    expect(list.items.length).toBe(1);
    // The list must stay slim: sizes and a flag, never the bodies.
    expect(list.items[0]).not.toHaveProperty("prompt");
    expect(list.items[0].hasTranscript).toBe(true);

    const run = await getLlmRun(list.items[0].id);
    expect(run?.prompt).toContain("classify this posting");
    expect(run?.response).toContain("verdict: pass");
    expect(run?.promptTruncated).toBe(false);
  });

  it("keeps the prompt on a failed call so the failure is debuggable", async () => {
    await expect(
      logged("evaluate", "test-model", null, async () => { throw new Error("gateway exploded"); }, [{ role: "user", content: "evaluate this" }]),
    ).rejects.toThrow("gateway exploded");
    const list = await listLlmRuns({ operation: "evaluate", status: "error" });
    const run = await getLlmRun(list.items[0].id);
    expect(run?.status).toBe("error");
    expect(run?.error).toContain("gateway exploded");
    expect(run?.prompt).toContain("evaluate this");
  });

  it("truncates an oversized prompt but records its real size", async () => {
    const huge = "x".repeat(LLM_TRANSCRIPT_MAX_CHARS * 2);
    await logged("materials", "test-model", null, async () => result("ok"), [{ role: "user", content: huge }]);
    const list = await listLlmRuns({ operation: "materials" });
    const run = await getLlmRun(list.items[0].id);
    expect(run!.prompt!.length).toBeLessThanOrEqual(LLM_TRANSCRIPT_MAX_CHARS);
    expect(run!.promptChars).toBeGreaterThan(LLM_TRANSCRIPT_MAX_CHARS);
    expect(run!.promptTruncated).toBe(true);
  });

  it("searches across stored transcripts", async () => {
    const hit = await listLlmRuns({ q: "Senior SRE, Brazil" });
    expect(hit.items.some((r) => r.operation === "triage")).toBe(true);
    expect((await listLlmRuns({ q: "no-such-text-anywhere" })).items).toHaveLength(0);
  });

  it("captures tool-only responses and correlates tool results", async () => {
    const toolCalls = [{ id: "call-1", name: "list_positions", arguments: "{}" }];
    await logged("chat", "test-model", null, async () => ({ ...result(""), toolCalls }), [
      { role: "assistant", content: null, tool_calls: toolCalls },
      { role: "tool", content: "[]", tool_call_id: "call-1" },
    ]);
    const list = await listLlmRuns({ operation: "chat" });
    const run = await getLlmRun(list.items[0].id);
    expect(run?.prompt).toContain("list_positions");
    expect(run?.prompt).toContain("call-1");
    expect(run?.response).toContain("list_positions");
  });

  it("retains a malformed provider response on failure", async () => {
    await expect(logged("test", "test-model", null, async () => { throw new LlmError("invalid JSON", 200, "malformed-answer"); })).rejects.toThrow("invalid JSON");
    const list = await listLlmRuns({ operation: "test" });
    expect((await getLlmRun(list.items[0].id))?.response).toBe("malformed-answer");
  });

  it("bounds body search, keeps historical metadata and treats wildcards literally", async () => {
    await logged("company_research", "test-model", null, async () => result("old distinctive body"));
    const old = (await listLlmRuns({ operation: "company_research" })).items[0];
    await (await getDb()).update(llmRuns).set({ createdAt: new Date(Date.now() - 15 * 86400_000) }).where(eq(llmRuns.id, old.id));
    expect((await listLlmRuns({ q: "old distinctive body" })).total).toBe(0);
    expect((await listLlmRuns({ operation: "company_research" })).total).toBe(1);
    expect((await listLlmRuns({ q: "   ", operation: "company_research" })).total).toBe(1);
    expect((await listLlmRuns({ q: "distinctive" })).searchSince).toBeTruthy();
    await logged("form_answers", "test-model", null, async () => result("literal 100%_done\\path"));
    expect((await listLlmRuns({ q: "%_done\\path" })).total).toBe(1);
    expect((await listLlmRuns({ q: "absent%" })).total).toBe(0);
  });
});
