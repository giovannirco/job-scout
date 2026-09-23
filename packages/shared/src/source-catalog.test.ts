import { describe, expect, it } from "vitest";
import { ATS_CATALOG, MARKET_CATALOG } from "./source-catalog.js";

describe("source catalog", () => {
  it("marks Remote OK as a scanned list_api feed", () => {
    const row = MARKET_CATALOG.find((e) => e.token === "remoteok");
    expect(row).toMatchObject({
      company: "Remote OK",
      capability: "list_api",
      sourceKind: "market",
    });
    expect(["remoteok", "market"]).toContain(row?.provider);
  });

  it("marks We Work Remotely DevOps/Sysadmin RSS as a scanned list_api feed", () => {
    const row = MARKET_CATALOG.find((e) => e.token === "weworkremotely");
    expect(row).toMatchObject({
      company: "We Work Remotely",
      capability: "list_api",
      sourceKind: "market",
      provider: "market",
    });
    expect(row?.careersUrl).toContain("remote-devops-sysadmin-jobs");
    expect(row?.notes).toMatch(/rss/i);
  });

  it("marks Remotive as a scanned list_api feed", () => {
    const remotive = MARKET_CATALOG.find((e) => e.token === "remotive");
    expect(remotive).toMatchObject({
      company: "Remotive",
      capability: "list_api",
      sourceKind: "market",
    });
    expect(remotive?.notes).toMatch(/api/i);
  });

  it("includes crypto and remote ATS boards probed live", () => {
    const keys = ATS_CATALOG.map((e) => `${e.provider}:${e.token}`);
    for (const k of [
      "greenhouse:galaxy",
      "greenhouse:canonical",
      "greenhouse:hut8",
      "greenhouse:blockchain",
      "greenhouse:consensys",
      "ashby:blockstream",
      "ashby:polymarket",
      "ashby:camunda",
      "ashby:openai",
      "ashby:primer.io",
    ]) {
      expect(keys).toContain(k);
    }
  });

  it("has unique provider+token pairs across the full catalog", () => {
    const keys = [...ATS_CATALOG, ...MARKET_CATALOG].map((e) => `${e.provider}:${e.token}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
