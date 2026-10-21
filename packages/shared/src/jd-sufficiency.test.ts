import { describe, expect, it } from "vitest";
import { bypassesFollowUpLimit, jdSubstantiallyRewritten, jdSufficiency } from "./jd-sufficiency.js";
import { isCosmeticTextChange } from "./hash.js";
import { isBoardIndexTitle, isShellJobTitle } from "./listing-title.js";

const JD = "Run the Kubernetes platform for a payments product. Own Terraform modules, CI/CD, observability and on-call. "
  + "We expect five years operating production infrastructure, strong Linux and networking skills, and clear writing.";

describe("jdSufficiency", () => {
  it("flags an empty body, a title-only body and a few words of page chrome", () => {
    expect(jdSufficiency("Senior Platform Engineer", "")).toMatchObject({ sufficient: false, reason: "empty" });
    expect(jdSufficiency("Senior Platform Engineer", "Senior Platform Engineer")).toMatchObject({ sufficient: false, reason: "title_only" });
    expect(jdSufficiency("Senior Platform Engineer", "Senior Platform Engineer\nApply now · Remote · Full time")).toMatchObject({ sufficient: false, reason: "title_only" });
    expect(jdSufficiency("Senior Platform Engineer", "Senior Platform Engineer. Kubernetes and Terraform.")).toMatchObject({ sufficient: false, reason: "too_short" });
  });

  it("accepts a real JD, including one that repeats the title", () => {
    expect(jdSufficiency("Senior Platform Engineer", JD).sufficient).toBe(true);
    expect(jdSufficiency("Senior Platform Engineer", `Senior Platform Engineer\n\n${JD}`).sufficient).toBe(true);
  });
});

describe("rewrite and follow-up helpers", () => {
  it("a rewrite keeps less than half the words; an added line is an edit", () => {
    expect(jdSubstantiallyRewritten(JD, `${JD} Visa sponsorship is not available.`)).toBe(false);
    expect(jdSubstantiallyRewritten(JD, "Design marketing campaigns for a retail brand, manage agencies and budgets, report on growth.")).toBe(true);
  });

  it("title/pay/location and an arriving JD bypass the follow-up limit; description edits do not", () => {
    for (const k of ["title", "comp", "geo", "jd_arrived", "closed", "reopened"]) expect(bypassesFollowUpLimit(k), k).toBe(true);
    for (const k of ["content", "noise_rebase", undefined]) expect(bypassesFollowUpLimit(k), String(k)).toBe(false);
  });
});

describe("isCosmeticTextChange", () => {
  const block = (...parts: string[]) => parts.join("\n\n");
  const about = "About Acme Example: we build payment rails for small shops.";
  const role = "You will run Kubernetes and Terraform for the payments platform.";
  const reqs = "Requirements:\n5+ years with Kubernetes\nStrong Linux";

  it("ignores whitespace, tracking params, date stamps and reordered blocks", () => {
    expect(isCosmeticTextChange(block(role, reqs), block(`  ${role}  `, reqs.replace(/\n/g, "\n  ")))).toBe(true);
    expect(isCosmeticTextChange(`${role} Apply at https://jobs.acme-example.com/apply/42`, `${role} Apply at https://jobs.acme-example.com/apply/42?utm_source=feed&gh_src=abc`)).toBe(true);
    expect(isCosmeticTextChange(block(role, "Posted 3 days ago"), block(role, "Posted 10 days ago"))).toBe(true);
    expect(isCosmeticTextChange(block(role, "Updated on Oct 2, 2026"), block(role, "Updated on October 9, 2026"))).toBe(true);
    expect(isCosmeticTextChange(block(about, role, reqs), block(role, reqs, about))).toBe(true);
  });

  it("keeps real edits material", () => {
    expect(isCosmeticTextChange(block(role, reqs), block(role, reqs, "US residents only."))).toBe(false);
    expect(isCosmeticTextChange(block(role, reqs), block(role, reqs.replace("5+", "8+")))).toBe(false);
    // A requirement moving into "nice to have" is a change, even with the same words.
    expect(isCosmeticTextChange(block(role, "Requirements:\nGo\nRust", "Nice to have:\nPython"), block(role, "Requirements:\nGo", "Nice to have:\nRust\nPython"))).toBe(false);
    expect(isCosmeticTextChange(`${role} https://jobs.acme-example.com/apply/42`, `${role} https://jobs.acme-example.com/apply/43`)).toBe(false);
    expect(isCosmeticTextChange("", role)).toBe(false);
  });
});

describe("isBoardIndexTitle", () => {
  it("matches careers listing titles", () => {
    for (const t of ["Job openings", "Job Openings | Acme Example", "Open positions", "Current openings", "Careers", "Careers at Acme Example", "Jobs at Acme Example", "Vagas", "Trabalhe conosco", "Join our team"]) {
      expect(isBoardIndexTitle(t), t).toBe(true);
      expect(isShellJobTitle(t), t).toBe(true);
    }
  });

  it("never matches a role", () => {
    for (const t of ["Senior Platform Engineer", "Careers - Platform Engineer", "Platform Engineer | Acme Careers", "Open Source Engineer", "Job Scheduler Engineer"]) {
      expect(isBoardIndexTitle(t), t).toBe(false);
    }
  });
});
