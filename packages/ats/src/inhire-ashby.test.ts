import { afterEach, describe, expect, it, vi } from "vitest";
import { detectAts } from "./detect.js";
import { ashbySalaryRaw, fetchAshbyJob, fetchJobFromUrl } from "./fetch.js";

const JOB_ID = "c0ffee00-abcd-4ef0-9abc-deadbeefcafe";
const URL_ = `https://acmepay.inhire.app/vagas/${JOB_ID}/cloud-platform-engineer`;

afterEach(() => vi.unstubAllGlobals());

describe("InHire", () => {
  it("detects tenant + job id and skips non-tenant hosts", () => {
    expect(detectAts(URL_)).toMatchObject({ provider: "inhire", boardToken: "acmepay", jobId: JOB_ID });
    expect(detectAts(`https://api.inhire.app/vagas/${JOB_ID}`).provider).not.toBe("inhire");
  });

  it("uses the public JSON API with X-Tenant and never the page", async () => {
    const fetchMock = vi.fn(async (_u: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ tenantName: "Acme Pay", displayName: "Cloud Platform Engineer", description: "<p>Opera&ccedil;&atilde;o de Kubernetes</p>", status: "published", workplaceType: "Remote", location: "BR", jobId: JOB_ID }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const job = await fetchJobFromUrl(URL_);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(`https://api.inhire.app/job-posts/public/pages/${JOB_ID}`);
    expect((fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>)["X-Tenant"]).toBe("acmepay");
    expect(job).toMatchObject({ provider: "inhire", title: "Cloud Platform Engineer", company: "Acme Pay", locationRaw: "Brasil", listingStatus: "open", externalIdentity: `inhire:acmepay:${JOB_ID}` });
    expect(job.descriptionText).toContain("Kubernetes");
  });

  it("refuses an API answer for a different job id", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ jobId: "other", displayName: "Senior DevOps Engineer" }), { status: 200 })));
    const job = await fetchJobFromUrl(URL_);
    expect(job.title).toBe("");
    expect((job.rawPayload as { fetchFailed?: string }).fetchFailed).toBe("job_id_mismatch");
  });

  it("404 or unpublished means closed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
    expect((await fetchJobFromUrl(URL_)).listingStatus).toBe("closed");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ jobId: JOB_ID, displayName: "Cloud Platform Engineer", status: "closed" }), { status: 200 })));
    expect((await fetchJobFromUrl(URL_)).listingStatus).toBe("closed");
  });
});

describe("Ashby posting API", () => {
  const salary = { compensationType: "Salary", interval: "1 YEAR", currencyCode: "USD", minValue: 120000, maxValue: 150000 };
  it("reads compensation from summaryComponents / tiers", () => {
    expect(ashbySalaryRaw({ summaryComponents: [{ compensationType: "EquityPercentage", minValue: 0.1 }, salary] })).toBe("USD 120000–150000 per year");
    expect(ashbySalaryRaw({ compensationTiers: [{ components: [{ ...salary, interval: "1 HOUR", minValue: 60, maxValue: 80 }] }] })).toBe("USD 60–80 per hour");
    expect(ashbySalaryRaw({ scrapeableCompensationSalarySummary: "$120K – $150K" })).toBe("$120K – $150K");
    expect(ashbySalaryRaw(undefined)).toBeUndefined();
  });

  it("a job missing from an answering board is closed (page 200 is not liveness)", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("https://api.ashbyhq.com/posting-api/job-board/acme")) return new Response(JSON.stringify({ jobs: [{ id: "someone-else", title: "Other" }] }), { status: 200 });
      return new Response("<html><title>Jobs</title></html>", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const job = await fetchAshbyJob("acme", "abcdef01-2222-4333-8444-abcdefabcdef");
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("includeCompensation=true");
    expect(job.listingStatus).toBe("closed");
    expect((job.rawPayload as { closedReason?: string }).closedReason).toBe("not_on_board");
  });

  it("stores compensation as salaryRaw for a listed job", async () => {
    const id = "abcdef01-2222-4333-8444-abcdefabcdef";
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("https://api.ashbyhq.com/posting-api/job-board/acme")) return new Response(JSON.stringify({ jobs: [{ id, title: "Platform Engineer", descriptionPlain: "Run Kubernetes. ".repeat(20), jobUrl: `https://jobs.ashbyhq.com/acme/${id}`, location: "Remote", compensation: { summaryComponents: [salary] } }] }), { status: 200 });
      return new Response("<html></html>", { status: 200 });
    }));
    const job = await fetchAshbyJob("acme", id);
    expect(job.listingStatus).toBe("open");
    expect(job.salaryRaw).toBe("USD 120000–150000 per year");
  });
});
