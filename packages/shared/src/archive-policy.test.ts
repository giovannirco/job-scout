import { describe, expect, it } from "vitest";
import { hardDisqualifierKind, isAutomatedActor, isCareerOpsActor, postedYearlyUsdMax, triageArchiveDecision } from "./archive-policy.js";

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
    ["Visa sponsorship not available", "work_authorization"],
    ["US citizens only", "work_authorization"],
    ["Onsite 3 days a week in Denver", "workplace"],
    ["Relocation required to Toronto", "workplace"],
    ["Must be willing to relocate to Lisbon", "workplace"],
    ["Must live within commuting distance of the Austin office", "workplace"],
    ["Employment limited to countries the candidate cannot work from with no contractor path", "residency"],
    ["Candidates must be based in Germany", "residency"],
    ["Ineligible location", "residency"],
    ["Posted pay max $120k is below last cash and the ask", "pay"],
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
    "No Visa/payments domain experience",
    "Visa or Mastercard network integration experience not claimed",
    "multi-country payroll experience not claimed",
    "Experience limited to Terraform; Pulumi required",
    "Hybrid cloud experience not claimed",
    "Hybrid-cloud networking ownership not claimed",
    "Relocation assistance tooling experience not claimed",
    "Clearance-sale e-commerce domain experience not claimed",
    "Comp not stated",
    "Cash management domain experience not claimed",
    "Payments platform experience based in fintech not claimed",
    "Error rate under 1% SLO ownership not claimed",
    "Sponsor-facing clinical trial domain not claimed",
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

  it("pay archives only when a floor is set and posted USD yearly pay is under it", () => {
    expect(triageArchiveDecision({ hardDq: ["Compensation below floor"], salaryRaw: null, payFloorUsd: 100000 })).toEqual({ archive: false, why: "pay_not_posted" });
    expect(triageArchiveDecision({ hardDq: ["Compensation below floor"], salaryRaw: "$120k - $150k", payFloorUsd: 100000 })).toEqual({ archive: false, why: "pay_at_or_above_floor" });
    expect(triageArchiveDecision({ hardDq: ["Compensation below floor"], salaryRaw: "$50k - $60k", payFloorUsd: 100000 })).toMatchObject({ archive: true, kind: "pay" });
    expect(triageArchiveDecision({ hardDq: ["Compensation below floor"], salaryRaw: "$4,000/month", payFloorUsd: 100000 })).toMatchObject({ archive: true, kind: "pay" });
  });

  it("pay never archives without a cash floor", () => {
    for (const payFloorUsd of [0, null, undefined]) {
      expect(triageArchiveDecision({ hardDq: ["Compensation below floor"], salaryRaw: "$300,000 - $350,000", payFloorUsd })).toEqual({ archive: false, why: "pay_floor_unset" });
      expect(triageArchiveDecision({ hardDq: ["Compensation below floor"], salaryRaw: "$50k", payFloorUsd })).toEqual({ archive: false, why: "pay_floor_unset" });
    }
  });

  it("pay never archives when the posted figure is not comparable USD yearly pay", () => {
    // BRL monthly pay: not converted, so it cannot be compared with a USD floor.
    expect(triageArchiveDecision({ hardDq: ["Compensation below floor"], salaryRaw: "R$ 8.000 por mês", payFloorUsd: 100000 })).toEqual({ archive: false, why: "pay_not_comparable" });
    expect(triageArchiveDecision({ hardDq: ["Compensation below floor"], salaryRaw: "€60k", payFloorUsd: 100000 })).toEqual({ archive: false, why: "pay_not_comparable" });
    expect(triageArchiveDecision({ hardDq: ["Compensation below floor"], salaryRaw: "$9500", payFloorUsd: 100000 })).toEqual({ archive: false, why: "pay_not_comparable" });
    expect(triageArchiveDecision({ hardDq: ["Compensation below floor"], salaryRaw: "competitive", payFloorUsd: 100000 })).toEqual({ archive: false, why: "pay_not_comparable" });
  });

  it("a non-pay hard disqualifier still archives after an unarchivable pay line", () => {
    expect(triageArchiveDecision({ hardDq: ["Compensation below floor", "Must reside in Canada"], salaryRaw: "€60k", payFloorUsd: 100000 })).toMatchObject({ archive: true, kind: "residency" });
  });

  it("skill-gap lines that mention visa, countries or limits never archive", () => {
    expect(triageArchiveDecision({ hardDq: ["No Visa/payments domain experience", "multi-country payroll experience not claimed", "limited to Terraform"] })).toEqual({ archive: false, why: "no_hard_disqualifier" });
  });

  it("reads posted pay as yearly USD", () => {
    expect(postedYearlyUsdMax("$5k/month")).toBe(60000);
    expect(postedYearlyUsdMax("$90,000 - $110,000")).toBe(110000);
    expect(postedYearlyUsdMax("€80k")).toBeNull();
    expect(postedYearlyUsdMax("$9500")).toBeNull(); // looks monthly: unknown, not $9.5k/year
  });
});

describe("automated actors", () => {
  it.each(["system", "autopilot", "career-ops", "career-ops-sync", "intake", "scan", "scan:greenhouse", "scan:discovery", "triage", "evaluate", "interview_brief", "watch", "repair", "import", "seed", null, ""])("%s is automated", (a) => expect(isAutomatedActor(a)).toBe(true));
  it.each(["operator", "Example Operator", "career-agent", "sync-agent", "chat", "manual", "clip", "mcp-client", "scanner-bot-owner"])("%s is a person or operator agent", (a) => expect(isAutomatedActor(a)).toBe(false));
  it("career-ops actor matches the sync token names only", () => {
    expect(isCareerOpsActor("career-ops")).toBe(true);
    expect(isCareerOpsActor("Career-Ops sync")).toBe(true);
    expect(isCareerOpsActor("career-opsy")).toBe(false);
    expect(isCareerOpsActor("my-career-ops")).toBe(false);
  });
});

describe("actor attribution format", () => {
  it("reads career-ops from either side of '<agent> via <token>'", () => {
    expect(isCareerOpsActor("career-ops via shared-agent")).toBe(true);
    expect(isCareerOpsActor("desk-agent via career-ops-sync")).toBe(true);
    expect(isCareerOpsActor("desk-agent via shared-agent")).toBe(false);
    expect(isAutomatedActor("career-ops via shared-agent")).toBe(true);
    expect(isAutomatedActor("someone via scan:greenhouse")).toBe(true);
    expect(isAutomatedActor("desk-agent via shared-agent")).toBe(false);
  });
});
