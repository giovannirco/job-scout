import { describe, expect, it } from "vitest";
import { leadDedupeKey, leadPayCheck, leadTriage, normalizeProfileUrl, redactContactText } from "./lead.js";

describe("redactContactText", () => {
  it("redacts phone numbers in common formats", () => {
    expect(redactContactText("Call me on +1 555-555-0142 tomorrow")).toBe("Call me on [phone] tomorrow");
    expect(redactContactText("whatsapp 15555550199")).toBe("whatsapp [phone]");
    expect(redactContactText("(155) 555-0123 or +1 (555) 555 0100")).toBe("[phone] or [phone]");
  });
  it("redacts numbers shared as WhatsApp or tel links", () => {
    expect(redactContactText("ping https://wa.me/15555550142 or api.whatsapp.com/send?phone=15555550143 or tel:+15555550144"))
      .toBe("ping https://wa.me/[phone] or api.whatsapp.com/send?phone=[phone] or tel:[phone]");
  });
  it("redacts email addresses", () => {
    expect(redactContactText("reach dana.recruiter@example.com")).toBe("reach [email]");
  });
  it("leaves dates, times, salaries and URL ids alone", () => {
    const text = "Slot 2026-10-21 10:00, range $150,000 - $190,000, see https://example.com/in/jobs/view/3912345678";
    expect(redactContactText(text)).toBe(text);
  });
});

describe("leadDedupeKey", () => {
  it("normalizes the profile URL and role so two threads collapse", () => {
    const a = leadDedupeKey({ recruiterProfileUrl: "https://www.example.com/in/Dana-Fictional/?utm=x", pitchedRole: "Senior SRE" });
    const b = leadDedupeKey({ recruiterProfileUrl: "example.com/in/dana-fictional", pitchedRole: "senior  sre!" });
    expect(a).toBe(b);
    expect(a).toBe("example.com/in/dana-fictional|senior sre");
  });
  it("falls back to email, then name and firm, and is null without a recruiter", () => {
    expect(leadDedupeKey({ recruiterEmail: "Dana.Recruiter@Example.com", pitchedRole: "SRE" })).toBe("mailto:dana.recruiter@example.com|sre");
    expect(leadDedupeKey({ recruiterName: "Dana Fictional", recruiterCompany: "Talent Bridge Partners", pitchedRole: "SRE" })).toBe("name:dana fictional@talent bridge partners|sre");
    expect(leadDedupeKey({ pitchedRole: "SRE" })).toBeNull();
  });
  it("strips www and country subdomains from profile hosts", () => {
    expect(normalizeProfileUrl("https://br.linkedin.com/pub/someone/")).toBe("linkedin.com/pub/someone");
  });
});

describe("leadTriage", () => {
  const profile = { cashFloorUsd: 150_000, stackText: "kubernetes terraform aws" };

  it("flags an explicit USD yearly figure under the floor and keeps the parsed number", () => {
    const t = leadTriage({ pitchedRole: "Platform Engineer, Kubernetes", statedPay: "$90k/year", statedGeo: "Remote LATAM", statedContract: "contractor", clientHint: "fintech" }, profile);
    expect(t.pay).toEqual({ status: "below_floor", usdYearlyMax: 90_000, floorUsd: 150_000 });
    expect(t.verdict).toBe("fail");
    expect(t.stack.matched).toContain("kubernetes");
  });

  it("never invents a USD figure from a bare number, another currency or an hourly rate", () => {
    for (const statedPay of ["90k", "R$ 20.000/month", "EUR 70k", "$60/hour", "competitive"]) {
      const pay = leadPayCheck(statedPay, 150_000);
      expect(pay.usdYearlyMax).toBeNull();
      expect(["not_comparable", "not_stated"]).toContain(pay.status);
    }
    const t = leadTriage({ pitchedRole: "SRE", statedPay: "R$ 20.000/month", statedGeo: "Remote Brazil", statedContract: "PJ", clientHint: "bank" }, profile);
    expect(t.pay.usdYearlyMax).toBeNull();
    expect(t.verdict).toBe("hold");
    expect(t.unknowns).toContain("pay in USD per year");
  });

  it("does not compare pay when the profile has no floor", () => {
    expect(leadPayCheck("$90k", 0)).toEqual({ status: "floor_unset", usdYearlyMax: null, floorUsd: null });
  });

  it("holds a lead with open unknowns and fails onsite terms", () => {
    const hold = leadTriage({ pitchedRole: "DevOps Engineer", openUnknowns: ["team size"] }, profile);
    expect(hold.verdict).toBe("hold");
    expect(hold.unknowns).toEqual(expect.arrayContaining(["team size", "client", "pay", "geography", "contract type"]));
    const onsite = leadTriage({ pitchedRole: "SRE", statedGeo: "Onsite in Austin, TX", statedPay: "$200k", statedContract: "FTE", clientHint: "retail" }, profile);
    expect(onsite.verdict).toBe("fail");
    expect(onsite.geo.workplace).toBe("onsite");
  });
});
