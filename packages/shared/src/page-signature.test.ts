import { describe, expect, it } from "vitest";
import { bodyNotFoundPlausible, bodySignature, isJsWallText, snapshotPageVerdict, titleSignature, titleSimilarity } from "./page-signature.js";
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

describe("guards never refuse a real JD (review follow-ups)", () => {
  it("a short frontend JD that requires JavaScript is not a JS wall", () => {
    const jd = "Frontend Engineer. Requires JavaScript, TypeScript and React. JavaScript required; Node.js is a plus. Remote, Brazil.";
    expect(isJsWallText(jd)).toBe(false);
    expect(bodySignature(jd)).toBeNull();
    expect(snapshotPageVerdict("Frontend Engineer", { title: "Frontend Engineer", descriptionText: jd })).toEqual({ refuse: false });
    expect(titleSignature("Frontend Engineer – JavaScript Required")).toBeNull();
    expect(bodySignature("Vaga de desenvolvedor front-end: a vaga precisa de JavaScript e TypeScript.")).toBeNull();
    // A noscript footer on a real JD leaves plenty of other content.
    expect(isJsWallText(`Build our payments UI in React and TypeScript, own design-system components and ship weekly. ${"You will pair with backend engineers on APIs. ".repeat(6)} Please enable JavaScript to view this site.`)).toBe(false);
  });

  it("true JS walls are still caught", () => {
    expect(isJsWallText("Please enable JavaScript to view this page.")).toBe(true);
    expect(isJsWallText("JavaScript is disabled in your browser.")).toBe(true);
    expect(isJsWallText("Habilite o JavaScript para continuar.")).toBe(true);
  });

  it("non-Latin titles are not placeholders", () => {
    expect(titleSignature("ソフトウェアエンジニア")).toBeNull();
    expect(titleSignature("Инженер")).toBeNull();
    expect(titleSignature("Инженер 404")).toBeNull();
    expect(bodySignature("Мы ищем инженера по надёжности: Kubernetes, Terraform, дежурства.")).toBeNull();
    expect(titleSignature("…")).toBe("placeholder");
    expect(titleSignature("Carregando...")).toBe("placeholder");
    expect(titleSimilarity("Инженер по надёжности", "Инженер по надёжности")).toBe(1);
  });

  it("not-found titles must be the whole title or a whole segment", () => {
    for (const t of ["Page Not Found", "404", "Error 404", "Acme Careers | Page not found", "Oops! Job not found", "This job is no longer available", "Vaga não encontrada", "Position has been filled"]) {
      expect(titleSignature(t), t).toBe("not_found");
    }
    for (const t of ["Not Found Engineer", "404 Labs - Backend Engineer", "Engineer for not-found pages and 404 handling", "Site Reliability Engineer (role no longer available in EU, open in BR)", "Expired Claims Analyst"]) {
      expect(titleSignature(t), t).toBeNull();
    }
  });

  it("body not-found needs subject-anchored phrasing and a short page", () => {
    expect(bodySignature("Once the position has been filled we will notify all candidates. Requires Kubernetes.")).toBeNull();
    expect(bodySignature("This position has been filled. Browse other openings.")).toBe("not_found");
    const longJd = `About the role: run our platform. Requirements: Kubernetes, Terraform. ${"Responsibilities include on-call and observability. ".repeat(12)} When this position has been filled the posting closes.`;
    expect(bodySignature(longJd)).toBeNull();
  });

  it("a body-only soft-404 counts only when much shorter than the JD on file", () => {
    const prev = "Own the cloud platform: Kubernetes, Terraform, observability. ".repeat(20);
    expect(bodyNotFoundPlausible(prev, "Sorry, job not found.")).toBe(true);
    expect(bodyNotFoundPlausible(null, "Sorry, job not found.")).toBe(true);
    const sameLength = `This job is no longer available? No: ${"Kubernetes and Terraform work. ".repeat(10)}`;
    expect(bodyNotFoundPlausible(sameLength, sameLength)).toBe(false);
    expect(snapshotPageVerdict("SRE", { title: "SRE", descriptionText: sameLength }, { prevBody: sameLength })).toEqual({ refuse: false });
    expect(snapshotPageVerdict("SRE", { title: "SRE", descriptionText: "Sorry, job not found." }, { prevBody: prev })).toMatchObject({ refuse: true, signature: "not_found" });
  });
});

describe("identity guard: canonical ATS identity wins over company names", () => {
  const pos = {
    companyName: "Acme Pay",
    primaryUrl: "https://jobs.ashbyhq.com/acmepay/abcdef01-2222-4333-8444-abcdefabcdef",
    atsProvider: "ashby",
    atsJobId: "abcdef01-2222-4333-8444-abcdefabcdef",
    externalIdentity: "ashby:acmepay:abcdef01-2222-4333-8444-abcdefabcdef",
  };
  it("same external identity with a renamed company is the same posting", () => {
    expect(snapshotIdentityMismatch(pos, { company: "Globex Holdings", url: pos.primaryUrl, provider: "ashby", jobId: pos.atsJobId, externalIdentity: pos.externalIdentity })).toBeNull();
  });
  it("same provider + global job id (any case) is the same posting", () => {
    expect(snapshotIdentityMismatch(pos, { company: "Globex Holdings", url: pos.primaryUrl, provider: "ashby", jobId: pos.atsJobId.toUpperCase() })).toBeNull();
  });
  it("a tenant-scoped requisition id alone does not override a company mismatch", () => {
    expect(snapshotIdentityMismatch({ companyName: "Acme Pay", atsProvider: "workday", atsJobId: "R12345" }, { company: "Globex Labs", provider: "workday", jobId: "R12345" })).toMatch(/^company:/);
  });
});
