import { describe, expect, it } from "vitest";
import { DEFAULT_LLM_FALLBACK_MODEL, DEFAULT_SETTINGS, resolveSettings } from "./settings.js";

describe("llm fallback model", () => {
  it("defaults to grok-4.6", () => {
    expect(DEFAULT_LLM_FALLBACK_MODEL).toBe("grok-4.6");
    expect(DEFAULT_SETTINGS.llm.fallbackModel).toBe("grok-4.6");
    expect(resolveSettings({}).llm.fallbackModel).toBe("grok-4.6");
  });

  it("keeps a stored fallback and allows empty to disable", () => {
    expect(resolveSettings({ llm: { fallbackModel: "gpt-5.6-sol" } }).llm.fallbackModel).toBe("gpt-5.6-sol");
    expect(resolveSettings({ llm: { fallbackModel: "" } }).llm.fallbackModel).toBe("");
  });
});
