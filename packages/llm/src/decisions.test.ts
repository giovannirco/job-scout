import { describe, expect, it, vi } from "vitest";
import { parseDecisionResponse, requestDecision } from "./decisions.js";
import type { DecisionQuestions } from "@job-scout/shared";

const questions: DecisionQuestions = {
  route: { type: "choice", instructions: "Choose a route.", criteria: { review: "Needs review", skip: "Not relevant" } },
  evidence: { type: "noul", instructions: "Is the claim supported?" },
  fit: { type: "score", instructions: "How relevant?", criteria: ["No match", "Some match", "Clear match"] },
};
function response() { return { model: "typesafe/jev-1.13-20260917", usage: { input_tokens: 100, output_tokens: 30, cost: 0.0000042 }, answers: {
  route: { type: "choice", choice: "review", confidence: 0.8, probabilities: { review: 0.9, skip: 0.1 } },
  evidence: { type: "noul", noul: 0.99 },
  fit: { type: "score", score: 1.5, confidence: 0.4, probabilities: { "0": 0, "1": 0.5, "2": 0.5 } },
} }; }

describe("OpenRouter Decisions contract", () => {
  it("reads the served snapshot, raw token fields and cost", () => {
    expect(parseDecisionResponse(response(), questions)).toMatchObject({ model: "typesafe/jev-1.13-20260917", inputTokens: 100, outputTokens: 30, cost: 0.0000042 });
  });
  it.each([
    (r: ReturnType<typeof response>) => { delete (r.answers as Partial<typeof r.answers>).evidence; },
    (r: ReturnType<typeof response>) => { r.answers.route.choice = "invented"; },
    (r: ReturnType<typeof response>) => { r.answers.route.choice = "skip"; },
    (r: ReturnType<typeof response>) => { r.answers.route.probabilities.review = 1.5; },
    (r: ReturnType<typeof response>) => { r.answers.route.probabilities.review = 0.2; },
    (r: ReturnType<typeof response>) => { r.answers.evidence.noul = -0.1; },
    (r: ReturnType<typeof response>) => { r.answers.fit.score = 2.8; },
    (r: ReturnType<typeof response>) => { r.answers.fit.score = 0; },
  ])("rejects malformed decisions before routing", mutate => {
    const r = response(); mutate(r); expect(() => parseDecisionResponse(r, questions)).toThrow();
  });
  it("uses the Decisions endpoint without chat completion fields", async () => {
    const mock = vi.fn<typeof fetch>().mockResolvedValue(Response.json(response()));
    const result = await requestDecision({ apiKey: "test-only", model: "typesafe/jev-1.13", state: { draft: "Synthetic text" }, questions, timeoutMs: 1000 }, mock);
    expect(mock.mock.calls[0][0]).toBe("https://openrouter.ai/api/alpha/decisions");
    const init = mock.mock.calls[0][1]!;
    expect(JSON.parse(init.body as string)).toEqual({ model: "typesafe/jev-1.13", state: { draft: "Synthetic text" }, questions });
    expect(init.redirect).toBe("error"); expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });
  it("does not expose provider bodies or credentials in errors", async () => {
    const mock = vi.fn<typeof fetch>().mockResolvedValue(new Response("Private provider text", { status: 401 }));
    await expect(requestDecision({ apiKey: "test-only", model: "typesafe/jev-1.13", state: "private", questions, timeoutMs: 1000 }, mock)).rejects.toThrow("OpenRouter rejected the API key.");
    expect(mock).toHaveBeenCalledTimes(1);
  });
  it("bounds response size", async () => {
    const mock = vi.fn<typeof fetch>().mockResolvedValue(new Response("x".repeat(256001)));
    await expect(requestDecision({ apiKey: "test-only", model: "typesafe/jev-1.13", state: "test", questions, timeoutMs: 1000 }, mock)).rejects.toThrow("too much data");
  });
  it("stops a stalled request at the configured timeout", async () => {
    const mock = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => new Promise((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(new Error("timeout")))));
    await expect(requestDecision({ apiKey: "test-only", model: "typesafe/jev-1.13", state: "test", questions, timeoutMs: 20 }, mock)).rejects.toThrow("time limit");
  });
});
