import { describe, expect, it } from "vitest";
import { hardDisqualifierKind, postedYearlyUsdMax, triageArchiveDecision } from "./archive-policy.js";

describe("hardDisqualifierKind", () => {
  it.each([
    ["Requires US citizenship", "work_authorization"],
    ["Active security clearance required", "work_authorization"],
    ["No visa sponsorship; must be authorized to work in the UK", "work_authorization"],
    ["On-site in Austin with no remote path", "workplace"],
    ["Hybrid, 3 days a week in the office", "workplace"],
    ["Posted salary below the cash floor", "pay"],
    ["Must reside in the United States", "residency"],
    ["US-only remote role", "residency"],
    ["Remote US-only; no contractor/EOR path", "residency"],
    ["Remote restricted to EMEA/APAC", "residency"],
    ["Hiring only in countries the candidate cannot work from", "residency"],
  ])("%s → %s", (text, kind) => expect(hardDisqualifierKind(text)).toBe(kind));

  it.each([
    "Required landing-zone and SCP ownership not claimed",
    "Missing required Kafka experience the candidate does not claim",
    "Required Go and Rust not claimed",
    "Azure ownership is the primary job (AWS-only; Azure not claimed)",
    "Required fluent Mandarin; candidate speaks English and Portuguese only",
    "New-grad posting; candidate is senior",
    "Score below threshold",
    "Must overlap 4 hours with EST time zone",
    "",
  ])("not hard: %s", (text) => expect(hardDisqualifierKind(text)).toBeNull());
});

describe("triageArchiveDecision", () => {
  it("skill gaps never archive", () => {
    expect(triageArchiveDecision({ hardDq: ["Required Terraform Cloud ownership not claimed"] })).toEqual({ archive: false, why: "no_hard_disqualifier" });
    expect(triageArchiveDecision({ hardDq: [] })).toEqual({ archive: false, why: "no_hard_disqualifier" });
  });

  it("archives on the first hard disqualifier", () => {
    expect(triageArchiveDecision({ hardDq: ["Kafka not claimed", "Onsite in Berlin"] })).toMatchObject({ archive: true, kind: "workplace", reason: "Onsite in Berlin" });
  });

  it("pay archives only when pay is posted and under the floor", () => {
    expect(triageArchiveDecision({ hardDq: ["Compensation below floor"], salaryRaw: null, payFloorUsd: 100000 })).toEqual({ archive: false, why: "pay_not_posted" });
    expect(triageArchiveDecision({ hardDq: ["Compensation below floor"], salaryRaw: "$120k - $150k", payFloorUsd: 100000 })).toEqual({ archive: false, why: "pay_at_or_above_floor" });
    expect(triageArchiveDecision({ hardDq: ["Compensation below floor"], salaryRaw: "$50k - $60k", payFloorUsd: 100000 })).toMatchObject({ archive: true, kind: "pay" });
    expect(triageArchiveDecision({ hardDq: ["Compensation below floor"], salaryRaw: "$4,000/month", payFloorUsd: 100000 })).toMatchObject({ archive: true, kind: "pay" });
    expect(triageArchiveDecision({ hardDq: ["Compensation below floor"], salaryRaw: "R$ 8.000 por mês", payFloorUsd: 100000 })).toMatchObject({ archive: true, kind: "pay" });
  });

  it("reads posted pay as yearly USD", () => {
    expect(postedYearlyUsdMax("$5k/month")).toBe(60000);
    expect(postedYearlyUsdMax("$90,000 - $110,000")).toBe(110000);
    expect(postedYearlyUsdMax("€80k")).toBeNull();
    expect(postedYearlyUsdMax("$9500")).toBeNull(); // looks monthly: unknown, not $9.5k/year
  });
});
