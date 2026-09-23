import { describe, expect, it } from "vitest";
import { createLlmClient, isQuotaLimitError, LlmError, parseJsonLenient, parseLastJsonValue, splitDocument } from "./client.js";

describe("splitDocument", () => {
  it("takes the trailing fenced json block and returns the markdown before it", () => {
    const r = splitDocument("## A\nbody\n\n```json\n{\"score\":4,\"verdict\":\"apply\"}\n```", []);
    expect(r.markdown).toBe("## A\nbody");
    expect(r.json).toEqual({ score: 4, verdict: "apply" });
  });

  it("survives a model echoing the schema before the object (Claude)", () => {
    const schema = JSON.stringify({ type: "object", properties: { a: { type: "string" } }, required: ["a"] });
    const r = splitDocument(`doc\n\n\`\`\`json\n${schema}\n{"a":"value","b":[1,2]}\n\`\`\``, []);
    expect(r.json).toEqual({ a: "value", b: [1, 2] });
  });

  it("accepts an unfenced trailing object", () => {
    const r = splitDocument("doc line\n{\"a\":1}", []);
    expect(r.markdown).toBe("doc line");
    expect(r.json).toEqual({ a: 1 });
  });

  it("splits named sections", () => {
    const r = splitDocument("=== SECTION: resume ===\nR\n=== SECTION: cover ===\nC\n```json\n{}\n```", ["resume", "cover"]);
    expect(r.sections).toEqual({ resume: "R", cover: "C" });
  });
});

describe("parseLastJsonValue / parseJsonLenient", () => {
  it("returns the last top-level value when several are present", () => {
    expect(parseLastJsonValue('{"schema":1}\n{"a":2}')).toEqual({ a: 2 });
    expect(parseJsonLenient("text ```json\n{\"schema\":1}\n{\"a\":2}\n``` more")).toEqual({ a: 2 });
  });

  it("returns null when nothing parses", () => {
    expect(parseLastJsonValue("not json")).toBeNull();
  });
});

describe("isQuotaLimitError", () => {
  it("matches OpenAI quota and 429/402", () => {
    expect(isQuotaLimitError(new LlmError("llm 429 on /chat/completions: x", 429, '{"error":{"type":"insufficient_quota"}}'))).toBe(true);
    expect(isQuotaLimitError(new LlmError("llm 402", 402, "payment required"))).toBe(true);
    expect(isQuotaLimitError(new LlmError("llm 403: You exceeded your current quota", 403, "You exceeded your current quota"))).toBe(true);
    expect(isQuotaLimitError(new LlmError("usage limit reached for Codex", 429, "usage limit reached"))).toBe(true);
    expect(isQuotaLimitError(new LlmError("llm 400 bad schema", 400, "invalid json_schema"))).toBe(false);
    expect(isQuotaLimitError(new LlmError("llm 500", 500, "upstream"))).toBe(false);
    expect(isQuotaLimitError(new Error("timeout"))).toBe(false);
  });
});

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("quota fallback on chat", () => {
  it("retries once on the fallback model when the primary hits quota", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || "{}")) as { model?: string };
      calls.push(body.model || "");
      if (body.model === "codex") {
        return jsonRes(429, { error: { message: "You exceeded your current quota", type: "insufficient_quota" } });
      }
      return jsonRes(200, {
        model: "grok-4.6",
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
    }) as typeof fetch;
    const client = createLlmClient({ baseUrl: "http://gw/v1", apiKey: "k", fetchImpl });
    const r = await client.chat({
      model: "codex",
      fallbackModel: "grok-4.6",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(calls).toEqual(["codex", "grok-4.6"]);
    expect(r.model).toBe("grok-4.6");
    expect(r.content).toBe("ok");
  });

  it("does not retry when fallback is the same model or missing", async () => {
    const fetchImpl = (async () => jsonRes(429, { error: { type: "insufficient_quota" } })) as typeof fetch;
    const client = createLlmClient({ baseUrl: "http://gw/v1", apiKey: "k", fetchImpl });
    await expect(client.chat({ model: "codex", messages: [{ role: "user", content: "hi" }] })).rejects.toBeInstanceOf(LlmError);
    await expect(
      client.chat({ model: "codex", fallbackModel: "codex", messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toBeInstanceOf(LlmError);
  });
});
