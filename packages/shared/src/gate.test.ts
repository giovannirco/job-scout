import { describe, expect, it } from "vitest";
import { gateListing } from "./gate.js";
import { DEFAULT_GATE } from "./settings.js";

describe("gateListing", () => {
  it("treats engineer and developer as the same job shape", () => {
    const gate = { ...DEFAULT_GATE, titleInclude: ["software engineer", "backend engineer"], titleExclude: ["manager"] };
    expect(gateListing({ title: "Software Developer (Backend SaaS)", locationRaw: "Remote" }, gate).pass).toBe(true);
    expect(gateListing({ title: "Senior Backend Developer", locationRaw: "Remote" }, gate).pass).toBe(true);
    expect(gateListing({ title: "Senior Software Engineer", locationRaw: "Remote" }, gate).matchedInclude).toBe("software engineer");
    expect(gateListing({ title: "Engineering Manager", locationRaw: "Remote" }, gate).pass).toBe(false);
  });

  it("passes a remote platform role", () => {
    const v = gateListing({ title: "Senior Platform Engineer", locationRaw: "Remote - LATAM" }, DEFAULT_GATE);
    expect(v.pass).toBe(true);
    expect(v.matchedInclude).toBe("platform engineer");
  });

  it("treats new grad and early career as junior", () => {
    const gate = { ...DEFAULT_GATE, titleInclude: ["software engineer"], titleExclude: ["junior", "intern"] };
    expect(gateListing({ title: "Software Engineer, New Grad 2027", locationRaw: "Remote" }, gate).reason).toBe("title_exclude:new grad");
    expect(gateListing({ title: "Software Engineer, Early Career — Immediate Start", locationRaw: "Remote" }, gate).reason).toBe("title_exclude:early career");
    expect(gateListing({ title: "New Graduate Software Engineer", locationRaw: "Remote" }, gate).reason).toBe("title_exclude:new graduate");
    expect(gateListing({ title: "Graduate Software Engineer, Open Source and Linux", locationRaw: "Remote" }, gate).reason).toBe("title_exclude:graduate");
    expect(gateListing({ title: "Software Engineer - Python - Cloud - graduate level", locationRaw: "Remote" }, gate).reason).toBe("title_exclude:graduate");
    expect(gateListing({ title: "Senior Software Engineer", locationRaw: "Remote" }, gate).pass).toBe(true);
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

  it("rejects a named office even when unknown geo is allowed", () => {
    const spain = gateListing({ title: "Site Reliability Engineer", locationRaw: "Spain" }, DEFAULT_GATE);
    expect(spain.pass).toBe(false);
    expect(spain.reason).toBe("geo_unlisted");
    const remoteOffice = gateListing({ title: "Site Reliability Engineer", locationRaw: "Spain", workplaceType: "Remote" }, DEFAULT_GATE);
    expect(remoteOffice.pass).toBe(true);
    const offices = gateListing({ title: "Site Reliability Engineer", locationRaw: "San Francisco, CA · New York City, NY" }, DEFAULT_GATE);
    expect(offices.pass).toBe(false);
  });

  it("keeps a country list when the board says remote", () => {
    const v = gateListing(
      {
        title: "Site Reliability Engineer",
        locationRaw: "Poland · Brazil · Sweden · Colombia",
        workplaceType: "Remote",
      },
      DEFAULT_GATE,
    );
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
