import { describe, expect, it } from "vitest";
import { gateListing } from "./gate.js";
import { DEFAULT_GATE } from "./settings.js";

describe("gateListing", () => {
  it("passes a remote platform role", () => {
    const v = gateListing({ title: "Senior Platform Engineer", locationRaw: "Remote - LATAM" }, DEFAULT_GATE);
    expect(v.pass).toBe(true);
    expect(v.matchedInclude).toBe("platform engineer");
  });

  it("rejects excluded titles before anything else", () => {
    const v = gateListing({ title: "Engineering Manager, Platform", locationRaw: "Remote" }, DEFAULT_GATE);
    expect(v.pass).toBe(false);
    expect(v.reason).toBe("title_exclude:manager");
  });

  it("rejects titles with no include term", () => {
    const v = gateListing({ title: "Senior Backend Engineer (Go)", locationRaw: "Remote" }, DEFAULT_GATE);
    expect(v.pass).toBe(false);
    expect(v.reason).toBe("title_no_include");
  });

  it("rejects blocked geo", () => {
    const v = gateListing({ title: "SRE", locationRaw: "Remote - US only" }, DEFAULT_GATE);
    expect(v.pass).toBe(false);
    expect(v.reason).toBe("geo_block:us only");
    const h = gateListing({ title: "SRE", locationRaw: "Hybrid - São Paulo" }, DEFAULT_GATE);
    expect(h.pass).toBe(false);
  });

  it("rejects stale postings", () => {
    const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
    const v = gateListing({ title: "DevOps Engineer", locationRaw: "Remote", postedAt: old }, DEFAULT_GATE);
    expect(v.pass).toBe(false);
    expect(v.reason).toMatch(/^stale:/);
  });

  it("unknown geo passes by default with a reason", () => {
    const v = gateListing({ title: "Site Reliability Engineer" }, DEFAULT_GATE);
    expect(v.pass).toBe(true);
    expect(v.reason).toBe("geo_unknown");
    const strict = gateListing({ title: "Site Reliability Engineer" }, { ...DEFAULT_GATE, allowUnknownGeo: false });
    expect(strict.pass).toBe(false);
  });

  it("bare words are bounded, phrases are substrings", () => {
    // "dba" must not match "dbaas platform engineer"? it is bounded so it should not match "dbaas"
    const v = gateListing({ title: "Platform Engineer (DBaaS)", locationRaw: "Remote" }, DEFAULT_GATE);
    expect(v.pass).toBe(true);
  });

  it("passes a remote multi-country list that includes Portugal", () => {
    const v = gateListing(
      {
        title: "Senior DevEx Engineer - Infrastructure",
        locationRaw:
          "United Kingdom · Hungary · Poland · South Africa · Portugal · Ireland · Romania",
        workplaceType: "Remote",
      },
      DEFAULT_GATE,
    );
    expect(v.pass).toBe(true);
    expect(v.reason).toBeNull();
  });
});
