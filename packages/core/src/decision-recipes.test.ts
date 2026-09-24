import { describe, expect, it } from "vitest";
import { DEFAULT_JEV, resolveSettings, type DecisionRecord, type DecisionResult } from "@job-scout/shared";
import { summarizeDecision } from "./decision-recipes.js";
import { fastTriageOutput } from "./fast-triage.js";

export function clearMatch(): DecisionResult {
  const score = { type: "score" as const, score: 4, confidence: 1, probabilities: { "0": 0, "1": 0, "2": 0, "3": 0, "4": 1 } };
  return { model: "typesafe/jev-1.13-20260917", latencyMs: 200, inputTokens: 400, outputTokens: 100, cost: 0.0000168, answers: {
    route: { type: "choice", choice: "shortlist", confidence: 1, probabilities: { shortlist: 1, review: 0, mismatch: 0 } },
    role: structuredClone(score), skills: structuredClone(score), seniority: structuredClone(score), eligible: { type: "noul", noul: 1 }, requirements: { type: "noul", noul: 1 },
  } };
}
export function record(result = clearMatch()): DecisionRecord { return { id: "test-decision", recipe: "triage", positionId: null, mode: "apply", status: "ok", model: result.model, result, summary: summarizeDecision("triage", result, DEFAULT_JEV), error: null, feedback: null, createdAt: new Date().toISOString() }; }

describe("decision policy", () => {
  it("leaves old installs disabled and merges partial settings", () => {
    expect(resolveSettings({}).jev.enabled).toBe(false);
    expect(resolveSettings({ jev: { weights: { role: 7 } } }).jev.weights).toEqual({ role: 7, skills: 4, seniority: 2 });
    expect(() => resolveSettings({ jev: { weights: { role: 0, skills: 0, seniority: 0 } } })).toThrow();
  });
  it("treats probability and confidence as independent requirements", () => {
    const r = clearMatch();
    if (r.answers.route.type === "choice") r.answers.route.confidence = 0.7;
    expect(summarizeDecision("triage", r, DEFAULT_JEV).accepted).toBe(false);
    const uncertain = clearMatch(); uncertain.answers.eligible = { type: "noul", noul: 0.9 };
    expect(summarizeDecision("triage", uncertain, DEFAULT_JEV).accepted).toBe(false);
  });
  it("accepts probability split between adjacent strong-fit levels", () => {
    const result = clearMatch();
    result.answers.skills = { type: "score", score: 3.5, confidence: 0, probabilities: { "0": 0, "1": 0, "2": 0, "3": 0.5, "4": 0.5 } };
    expect(summarizeDecision("triage", result, DEFAULT_JEV)).toMatchObject({ accepted: true, confidence: 1, probability: 1 });
  });
  it("weights semantic scores in code without treating them as salary or dates", () => {
    const r = clearMatch();
    if (r.answers.skills.type === "score") r.answers.skills.score = 2;
    expect(summarizeDecision("ranking", r, DEFAULT_JEV).score).toBe(4);
    expect(summarizeDecision("ranking", r, { ...DEFAULT_JEV, weights: { role: 0, seniority: 0, skills: 1 } }).score).toBe(2.5);
  });
  it("falls back for advertised pay, uncertainty, or a weak skill match", () => {
    const input = { salaryRaw: null, jdText: "Worldwide remote platform engineering role.", passThreshold: 3.5 };
    expect(fastTriageOutput(record(), input)?.score).toBe(5);
    expect(fastTriageOutput(record(), { ...input, salaryRaw: "100000 USD" })).toBeNull();
    expect(fastTriageOutput(record(), { ...input, jdText: "Salary is 80k per year." })).toBeNull();
    const r = clearMatch(); r.answers.requirements = { type: "noul", noul: 0.5 };
    expect(fastTriageOutput(record(r), input)).toBeNull();
    const weak = clearMatch(); if (weak.answers.skills.type === "score") weak.answers.skills.score = 2;
    expect(fastTriageOutput(record(weak), input)).toBeNull();
  });
  it("requires both candidate and role claims to pass", () => {
    const r: DecisionResult = { ...clearMatch(), answers: { outcome: { type: "choice", choice: "supported", confidence: 1, probabilities: { supported: 1, review: 0, revise: 0 } }, supported: { type: "noul", noul: 1 }, grounded: { type: "noul", noul: 0.1 } } };
    expect(summarizeDecision("evaluation_check", r, DEFAULT_JEV).accepted).toBe(false);
  });
});
