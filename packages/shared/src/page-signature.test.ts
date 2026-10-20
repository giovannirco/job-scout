import { describe, expect, it } from "vitest";
import { bodySignature, isJsWallText, snapshotPageVerdict, titleSignature, titleSimilarity } from "./page-signature.js";
import { companiesMatch, snapshotIdentityMismatch } from "./snapshot-guard.js";

/** The exact text an InHire job page serves without JavaScript (tenant prefix synthetic). */
const INHIRE_JS_WALL = "acmepay • • • … This website need Javascript. Please turn it on.";

describe("not-a-JD page signatures", () => {
  it("InHire JS wall is refused in title and body", () => {
    expect(isJsWallText(INHIRE_JS_WALL)).toBe(true);
    expect(bodySignature(INHIRE_JS_WALL)).toBe("js_wall");
    expect(snapshotPageVerdict("Cloud Platform Engineer III", { title: "Cloud Platform Engineer III", descriptionText: INHIRE_JS_WALL })).toEqual({ refuse: true, signature: "js_wall", where: "body" });
    expect(isJsWallText("You need to enable JavaScript to run this app.")).toBe(true);
    expect(isJsWallText("We run Kubernetes and need JavaScript skills on the team. ".repeat(40))).toBe(false);
  });
  it("vendor boilerplate", () => {
    expect(titleSignature("The customizable hiring software that helps you hire smarter and faster")).toBe("vendor_boilerplate");
    expect(snapshotPageVerdict("DevOps Engineer", { title: "The customizable hiring software that helps you hire smarter and faster", descriptionText: "A collaborative hiring software. Book a demo." })).toMatchObject({ refuse: true, signature: "vendor_boilerplate" });
  });
  it("soft-404", () => {
    expect(titleSignature("Job Not Found")).toBe("not_found");
    expect(titleSignature("This position is no longer available")).toBe("not_found");
    expect(bodySignature("Sorry, job not found. Browse other openings.")).toBe("not_found");
  });
  it("InHire placeholder", () => {
    expect(titleSignature("InHire")).toBe("placeholder");
    expect(bodySignature("inhire • • • •")).toBe("placeholder");
  });
  it("a real JD passes", () => {
    const jd = "We are hiring a platform engineer to run Kubernetes, Terraform and observability. ".repeat(5);
    expect(snapshotPageVerdict("Platform Engineer", { title: "Platform Engineer", descriptionText: jd })).toEqual({ refuse: false });
    expect(titleSignature("Site Reliability Engineer - Senior")).toBeNull();
    expect(titleSimilarity("DevOps Engineer (Senior/Staff)", "DevOps Engineer - Staff")).toBeGreaterThan(0.34);
  });
});

describe("cross-company clobber guard", () => {
  const pos = {
    companyName: "Acme Pay",
    primaryUrl: "https://acmepay.inhire.app/vagas/c0ffee00-abcd-4ef0-9abc-aaaaaaaaaaaa/site-reliability-engineer",
    atsProvider: "inhire",
    atsJobId: "c0ffee00-abcd-4ef0-9abc-aaaaaaaaaaaa",
    externalIdentity: "inhire:acmepay:c0ffee00-abcd-4ef0-9abc-aaaaaaaaaaaa",
  };
  it("rejects another company's posting", () => {
    expect(snapshotIdentityMismatch(pos, { company: "Globex Labs", url: "https://jobs.ashbyhq.com/globex/123", provider: "ashby", jobId: "123" })).toMatch(/^company:/);
  });
  it("rejects a different host without a company", () => {
    expect(snapshotIdentityMismatch(pos, { url: "https://weworkremotely.com/remote-jobs/globex-senior-devops-engineer" })).toMatch(/^url_host:/);
  });
  it("rejects a different job id on the same ATS", () => {
    expect(snapshotIdentityMismatch(pos, { company: "Acme Pay", url: pos.primaryUrl, provider: "inhire", jobId: "c0ffee00-abcd-4ef0-9abc-bbbbbbbbbbbb" })).toMatch(/^ats_job_id:/);
  });
  it("accepts the same posting", () => {
    expect(snapshotIdentityMismatch(pos, { company: "Acme Pay", url: pos.primaryUrl, provider: "inhire", jobId: pos.atsJobId, externalIdentity: pos.externalIdentity })).toBeNull();
  });
  it("company match tolerates suffixes and unknowns", () => {
    expect(companiesMatch("Acme Pay", "Grupo Acme Pay")).toBe(true);
    expect(companiesMatch("Acme Pay", "Globex Labs")).toBe(false);
    expect(companiesMatch("Acme Pay", undefined)).toBe(true);
    expect(companiesMatch("__unresolved__", "Globex Labs")).toBe(true);
  });
});
