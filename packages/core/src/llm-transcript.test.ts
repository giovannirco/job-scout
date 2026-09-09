import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb } from "@job-scout/db";
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
});
