import { describe, expect, it } from "vitest";
import {
  isNoiseJobTitle,
  isPlaceholderAtsUrl,
  isShellJobTitle,
  preferJobTitle,
  titleFromSlug,
} from "./listing-title.js";

describe("isShellJobTitle", () => {
  it("flags closed and board index titles", () => {
    expect(isShellJobTitle("Closed role")).toBe(true);
    expect(isShellJobTitle("Closed")).toBe(true);
    expect(isShellJobTitle("Current openings at Strike")).toBe(true);
    expect(isShellJobTitle("Jobs")).toBe(true);
    expect(isShellJobTitle("Careers")).toBe(true);
    expect(isShellJobTitle("Jobs at Strike")).toBe(true);
  });

  it("allows real role titles", () => {
    expect(isShellJobTitle("Platform Engineer, AI Systems")).toBe(false);
    expect(isShellJobTitle("Senior DevOps Engineer")).toBe(false);
    expect(isShellJobTitle("Site Reliability Engineer")).toBe(false);
  });
});

describe("isNoiseJobTitle", () => {
  it("flags empty and promote tokens", () => {
    expect(isNoiseJobTitle("")).toBe(true);
    expect(isNoiseJobTitle("2byg")).toBe(true);
    expect(isNoiseJobTitle("Closed role")).toBe(true);
  });

  it("allows real roles", () => {
    expect(isNoiseJobTitle("Senior SRE")).toBe(false);
    expect(isNoiseJobTitle("Platform Engineer")).toBe(false);
  });
});

describe("isPlaceholderAtsUrl", () => {
  it("flags example and zero UUIDs", () => {
    expect(
      isPlaceholderAtsUrl("https://job-boards.greenhouse.io/strike/jobs/example"),
    ).toBe(true);
    expect(
      isPlaceholderAtsUrl(
        "https://jobs.ashbyhq.com/chainlink-labs/example",
      ),
    ).toBe(true);
    expect(
      isPlaceholderAtsUrl(
        "https://jobs.ashbyhq.com/supabase/ed6cedb1-0000-0000-0000-000000000001",
      ),
    ).toBe(true);
    expect(
      isPlaceholderAtsUrl(
        "https://boards.greenhouse.io/careers/jobs/4945633101",
      ),
    ).toBe(true);
  });

  it("allows real ATS urls", () => {
    expect(
      isPlaceholderAtsUrl(
        "https://job-boards.greenhouse.io/strike/jobs/5779695004",
      ),
    ).toBe(false);
    expect(
      isPlaceholderAtsUrl(
        "https://jobs.ashbyhq.com/supabase/ed6cedb1-b9bf-4609-ac5c-c75c33b31bf3",
      ),
    ).toBe(false);
  });
});

describe("preferJobTitle", () => {
  it("keeps real existing when scrape is shell", () => {
    expect(
      preferJobTitle("Current openings at Strike", "Platform Engineer, AI Systems"),
    ).toBe("Platform Engineer, AI Systems");
  });

  it("keeps real title when closed placeholder arrives", () => {
    expect(preferJobTitle("Closed role", "Lead DevOps Engineer AWS")).toBe(
      "Lead DevOps Engineer AWS",
    );
  });

  it("falls back to slug", () => {
    expect(
      preferJobTitle("Closed role", "Closed role", {
        slug: "strike-platform-engineer-ai-systems",
        companySlug: "strike",
      }),
    ).toBe("Platform Engineer AI Systems");
  });
});

describe("titleFromSlug", () => {
  it("strips company prefix", () => {
    expect(titleFromSlug("nix-lead-devops-aws", "nix")).toBe("Lead Devops AWS");
  });
});
