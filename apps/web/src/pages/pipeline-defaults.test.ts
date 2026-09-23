import { describe, expect, it } from "vitest";
import { defaultPipelinePreset } from "./pipeline-defaults.js";

describe("pipeline default", () => {
  it("opens the filings when no model key is set", () => {
    expect(defaultPipelinePreset(false)).toBe("all");
  });

  it("opens PASS verdicts when a model key is set", () => {
    expect(defaultPipelinePreset(true)).toBe("decide");
  });
});
