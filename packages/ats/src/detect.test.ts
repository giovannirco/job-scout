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

describe("boardIndexUrl", () => {
  it("recognises ATS board roots and bare careers pages", async () => {
    const { boardIndexUrl } = await import("./detect.js");
    expect(boardIndexUrl("https://boards.greenhouse.io/acme-example")).toEqual({ provider: "greenhouse", boardToken: "acme-example", scannable: true });
    expect(boardIndexUrl("https://jobs.ashbyhq.com/acme-example")).toEqual({ provider: "ashby", boardToken: "acme-example", scannable: true });
    expect(boardIndexUrl("https://jobs.lever.co/acme-example")).toEqual({ provider: "lever", boardToken: "acme-example", scannable: true });
    expect(boardIndexUrl("https://apply.workable.com/acme-example/")).toEqual({ provider: "workable", boardToken: "acme-example", scannable: false });
    expect(boardIndexUrl("https://www.acme-example.com/careers")).toMatchObject({ provider: "unknown" });
    expect(boardIndexUrl("https://www.acme-example.com/en/jobs/")).toMatchObject({ provider: "unknown" });
  });

  it("never flags a single posting", async () => {
    const { boardIndexUrl } = await import("./detect.js");
    for (const url of [
      "https://boards.greenhouse.io/acme-example/jobs/1234567",
      "https://jobs.ashbyhq.com/acme-example/c0ffee00-abcd-4ef0-9abc-deadbeefcafe",
      "https://jobs.lever.co/acme-example/0d6c2b8e-1111-4222-8333-944455556666",
      "https://apply.workable.com/acme-example/j/AB12CD34EF/",
      "https://www.acme-example.com/careers?gh_jid=1234567",
      "https://www.acme-example.com/careers/platform-engineer",
      "https://weworkremotely.com/remote-jobs/acme-example-senior-devops-engineer",
    ]) expect(boardIndexUrl(url), url).toBeNull();
  });
});
