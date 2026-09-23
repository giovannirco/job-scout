import { describe, expect, it } from "vitest";
import { defaultPipelinePreset, pipelineSortFallback, pipelineSortOptions } from "./pipeline-defaults.js";

describe("pipeline default", () => {
  it("opens the filings when no model key is set", () => {
    expect(defaultPipelinePreset(false)).toBe("all");
  });

  it("opens PASS verdicts when a model key is set", () => {
    expect(defaultPipelinePreset(true)).toBe("decide");
  });

  it("keeps an explicit sort", () => {
    expect(pipelineSortFallback({ status: "active", sort: "company_asc" })).toBe("company_asc");
  });

  it("sorts a verdict filter by score", () => {
    expect(pipelineSortFallback({ verdict: "pass", status: "triaged" })).toBe("score_desc");
  });

  it("sorts open filings by first seen", () => {
    expect(pipelineSortFallback({ status: "active" })).toBe("first_seen_desc");
    expect(pipelineSortFallback({ verdict: "none", status: "triaged" })).toBe("first_seen_desc");
  });

  it("keeps an oldest-posted sort visible in the menu", () => {
    const options = pipelineSortOptions("posted_asc");
    expect(options.find((option) => option.value === "posted_asc")?.label).toBe("posted, oldest");
  });

  it("sorts working and archived lists by recent updates", () => {
    expect(pipelineSortFallback({ status: "hot" })).toBe("updated_desc");
    expect(pipelineSortFallback({ status: "archived" })).toBe("updated_desc");
  });
});
