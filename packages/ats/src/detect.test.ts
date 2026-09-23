import { describe, expect, it } from "vitest";
import {
  detectAts,
  greenhouseBoardToken,
  greenhouseListingNeedsBoardFetch,
  isPlaceholderAtsDetection,
  isPlaceholderJobId,
} from "./detect.js";

describe("detectAts", () => {
  it("parses greenhouse job-boards URL", () => {
    const d = detectAts(
      "https://job-boards.greenhouse.io/remotecom/jobs/7763713003",
    );
    expect(d.provider).toBe("greenhouse");
    expect(d.boardToken).toBe("remotecom");
    expect(d.jobId).toBe("7763713003");
    expect(d.placeholder).toBeFalsy();
  });

  it("flags greenhouse example seed urls", () => {
    const d = detectAts("https://job-boards.greenhouse.io/strike/jobs/example");
    expect(d.provider).toBe("greenhouse");
    expect(d.placeholder).toBe(true);
    expect(isPlaceholderAtsDetection(d)).toBe(true);
  });

  it("parses gh_jid query on company careers page", () => {
    const d = detectAts(
      "https://bitso.com/jobs/7799066003?gh_jid=7799066003",
    );
    expect(d.provider).toBe("greenhouse");
    expect(d.jobId).toBe("7799066003");
  });

  it("resolves a vanity greenhouse URL to the company board", () => {
    const boards = [
      { company: "Datadog", token: "datadog", careersUrl: "https://careers.datadoghq.com" },
      { company: "Elastic", token: "elastic", careersUrl: "https://www.elastic.co/careers" },
      { company: "Other", token: "other", careersUrl: "https://jobs.example.com" },
    ];
    expect(greenhouseBoardToken(boards, { companyName: "Datadog" })).toBe("datadog");
    expect(greenhouseBoardToken(boards, { url: "https://careers.datadoghq.com/detail/3851935/?gh_jid=3851935" })).toBe("datadog");
    expect(greenhouseBoardToken(boards, { url: "https://jobs.elastic.co/jobs?gh_jid=7982100&gh_jid=7982100" })).toBe("elastic");
    expect(greenhouseBoardToken(boards, { companyName: "Nope", url: "https://example.com/jobs?gh_jid=1" })).toBeNull();
  });

  it("does not use the jobs host label as a greenhouse board token", () => {
    const d = detectAts("https://jobs.elastic.co/jobs?gh_jid=8225986&gh_jid=8225986");
    expect(d.provider).toBe("greenhouse");
    expect(d.jobId).toBe("8225986");
    expect(d.boardToken).toBeUndefined();
    expect(
      greenhouseListingNeedsBoardFetch(
        { boardToken: d.boardToken },
        { provider: "greenhouse", token: "elastic", jobId: d.jobId },
      ),
    ).toBe(true);
    expect(
      greenhouseListingNeedsBoardFetch(
        { boardToken: "elastic" },
        { provider: "greenhouse", token: "elastic", jobId: d.jobId },
      ),
    ).toBe(false);
  });

  it("parses ashby UUID jobs", () => {
    const d = detectAts(
      "https://jobs.ashbyhq.com/supabase/ed6cedb1-b9bf-4609-ac5c-c75c33b31bf3",
    );
    expect(d.provider).toBe("ashby");
    expect(d.boardToken).toBe("supabase");
    expect(d.jobId).toBe("ed6cedb1-b9bf-4609-ac5c-c75c33b31bf3");
  });

  it("flags ashby zero uuid seeds", () => {
    const d = detectAts(
      "https://jobs.ashbyhq.com/supabase/ed6cedb1-0000-0000-0000-000000000001",
    );
    expect(d.provider).toBe("ashby");
    expect(isPlaceholderAtsDetection(d)).toBe(true);
  });

  it("parses lever postings", () => {
    const d = detectAts(
      "https://jobs.lever.co/luxurypresence/c8c67c22-5ba3-4284-8247-3564eaf2ccb6",
    );
    expect(d.provider).toBe("lever");
    expect(d.boardToken).toBe("luxurypresence");
    expect(d.jobId).toBe("c8c67c22-5ba3-4284-8247-3564eaf2ccb6");
  });

  it("parses workday tenant + req", () => {
    const d = detectAts(
      "https://company.wd5.myworkdayjobs.com/en-US/External/job/Remote_R-12345",
    );
    expect(d.provider).toBe("workday");
    expect(d.boardToken).toBe("company");
    expect(d.jobId).toBeTruthy();
  });

  it("parses smartrecruiters", () => {
    const d = detectAts(
      "https://jobs.smartrecruiters.com/Acme/123456789",
    );
    expect(d.provider).toBe("smartrecruiters");
    expect(d.boardToken).toBe("Acme");
    expect(d.jobId).toBe("123456789");
  });

  it("parses linkedin job view", () => {
    const d = detectAts("https://www.linkedin.com/jobs/view/4123456789/");
    expect(d.provider).toBe("linkedin");
    expect(d.jobId).toBe("4123456789");
  });
});

describe("isPlaceholderJobId", () => {
  it("rejects greenhouse non-numeric", () => {
    expect(isPlaceholderJobId("greenhouse", "example")).toBe(true);
    expect(isPlaceholderJobId("greenhouse", "5779695004")).toBe(false);
  });
});
