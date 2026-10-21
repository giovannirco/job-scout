import { describe, expect, it } from "vitest";
import { assessLlmHealth, assessOperation, classifyLlmFailure, llmHealthStateValue, type LlmRunSample } from "./llm-health.js";

const now = new Date("2026-03-02T12:00:00Z");
const at = (minAgo: number) => new Date(now.getTime() - minAgo * 60_000);
const fail = (operation: string, minAgo: number, error: string, latencyMs = 4_000): LlmRunSample => ({ operation, status: "error", error, latencyMs, createdAt: at(minAgo) });
const ok = (operation: string, minAgo: number): LlmRunSample => ({ operation, status: "ok", latencyMs: 3_000, tokensIn: 900, tokensOut: 120, createdAt: at(minAgo) });

describe("classifyLlmFailure", () => {
  it("names the provider failures seen in outages", () => {
    expect(classifyLlmFailure({ error: "llm 402 on /chat/completions: insufficient balance" })).toBe("quota");
    expect(classifyLlmFailure({ error: "llm 503 on /chat/completions: account balance is too low" })).toBe("quota");
    expect(classifyLlmFailure({ error: "llm 426 on /chat/completions: client outdated, please upgrade" })).toBe("upgrade_required");
    expect(classifyLlmFailure({ error: "llm 401 on /chat/completions: invalid api key" })).toBe("auth");
    expect(classifyLlmFailure({ error: "llm 502 on /chat/completions: bad gateway" })).toBe("outage");
    expect(classifyLlmFailure({ error: "fetch failed" })).toBe("outage");
    expect(classifyLlmFailure({ error: "", status: 429 })).toBe("quota");
  });

  it("treats an instant zero-token refusal as an outage, and a wrong answer as a plain error", () => {
    expect(classifyLlmFailure({ error: "llm returned non-JSON on /chat/completions: <html>", latencyMs: 90, tokens: 0 })).toBe("outage");
    expect(classifyLlmFailure({ error: "llm returned non-JSON on /chat/completions: <html>", latencyMs: 9_000 })).toBe("error");
    expect(classifyLlmFailure({ error: "llm output failed schema triage: billing timeout network", latencyMs: 50 })).toBe("error");
  });
});

describe("assessLlmHealth", () => {
  it("marks an operation failing after consecutive failures and reports a provider-wide kind", () => {
    const runs = [ok("triage", 50), fail("triage", 3, "llm 402 on x: insufficient balance"), fail("triage", 2, "llm 402 on x: insufficient balance"), fail("triage", 1, "llm 402 on x: insufficient balance"), ok("evaluate", 10)];
    const r = assessLlmHealth(runs, { now, operations: ["triage", "evaluate", "materials"] });
    expect(r.state).toBe("failing");
    expect(r.providerDown).toBe(true);
    expect(r.kind).toBe("quota");
    expect(r.failingOperations).toEqual(["triage"]);
    expect(r.failingSince).toBe(at(3).toISOString());
    const triage = r.operations.find((o) => o.operation === "triage")!;
    expect(triage).toMatchObject({ consecutiveFailures: 3, windowRuns: 3, windowFailures: 3, failureRatio: 1 });
    expect(r.operations.find((o) => o.operation === "materials")?.state).toBe("idle");
    expect(llmHealthStateValue(triage.state)).toBe(2);
  });

  it("keeps a long outage failing with sparse probes and recovers only on a success", () => {
    const sparse = [fail("triage", 300, "llm 426 on x: upgrade required"), fail("triage", 200, "llm 426 on x"), fail("triage", 100, "llm 426 on x")];
    expect(assessOperation("triage", sparse, { now }).state).toBe("failing");
    expect(assessOperation("triage", sparse, { now }).kind).toBe("upgrade_required");
    const recovered = assessOperation("triage", [...sparse, ok("triage", 1)], { now });
    expect(recovered.state).toBe("ok");
    expect(recovered.consecutiveFailures).toBe(0);
  });

  it("is degraded on a high failure ratio without a streak, and not provider-down for plain errors", () => {
    const runs = [fail("evaluate", 9, "e"), ok("evaluate", 8), fail("evaluate", 7, "e"), ok("evaluate", 6), fail("evaluate", 5, "e"), ok("evaluate", 4)];
    expect(assessLlmHealth(runs, { now }).state).toBe("degraded");
    const schema = [1, 2, 3].map((m) => fail("evaluate", m, "llm output failed schema evaluate: bad"));
    const r = assessLlmHealth(schema, { now });
    expect(r.state).toBe("failing");
    expect(r.providerDown).toBe(false);
    expect(r.kind).toBe("error");
  });
});
