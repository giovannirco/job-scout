import { afterEach, describe, expect, it, vi } from "vitest";
import { detectAts } from "./detect.js";
import { parseSalary } from "@job-scout/shared";
import { ashbySalaryRaw, fetchAshbyJob, fetchJobFromUrl, inhireListingStatus } from "./fetch.js";

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

  it("status compare is case-insensitive and only known closing statuses close", async () => {
    for (const st of ["closed", "CLOSED", "Expired", "unpublished", "archived", "canceled", "cancelled", "filled", "Encerrada"]) expect(inhireListingStatus(st), st).toBe("closed");
    for (const st of ["published", "PUBLISHED", "Published", "active", "open", "something_new", "", undefined]) expect(inhireListingStatus(st), String(st)).toBe("open");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ jobId: JOB_ID, displayName: "Cloud Platform Engineer", description: "<p>Kubernetes</p>", status: "PUBLISHED" }), { status: 200 })));
    expect((await fetchJobFromUrl(URL_)).listingStatus).toBe("open");
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

  it("weekly / daily compensation keeps its period and never reads as yearly", () => {
    const weekly = ashbySalaryRaw({ summaryComponents: [{ ...salary, interval: "1 WEEK", minValue: 2000, maxValue: 2500 }] });
    const daily = ashbySalaryRaw({ summaryComponents: [{ ...salary, interval: "1 DAY", minValue: 400, maxValue: 500 }] });
    expect(weekly).toBe("USD 2000–2500 per week");
    expect(daily).toBe("USD 400–500 per day");
    expect(parseSalary(weekly).period).not.toBe("year");
    expect(parseSalary(daily).period).not.toBe("year");
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

  const ID = "abcdef01-2222-4333-8444-abcdefabcdef";
  const board = (jobs: unknown[]) => new Response(JSON.stringify({ jobs }), { status: 200 });
  const stub = (boardRes: () => Response, page: () => Response) =>
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => (String(input).startsWith("https://api.ashbyhq.com/posting-api/job-board/") ? boardRes() : page())));

  it("an empty board is not evidence of closure", async () => {
    stub(() => board([]), () => new Response("<html><title>Jobs</title></html>", { status: 200 }));
    expect((await fetchAshbyJob("acme", ID)).listingStatus).not.toBe("closed");
  });

  it("job ids compare case-insensitively", async () => {
    stub(() => board([{ id: ID.toUpperCase(), title: "Platform Engineer", descriptionPlain: "Run Kubernetes. ".repeat(20), jobUrl: `https://jobs.ashbyhq.com/acme/${ID}` }]), () => new Response("<html></html>", { status: 200 }));
    const job = await fetchAshbyJob("acme", ID);
    expect(job).toMatchObject({ listingStatus: "open", title: "Platform Engineer" });
  });

  it("a board whose job URLs name another org is not evidence of closure", async () => {
    stub(() => board([{ id: "someone-else", title: "Other", jobUrl: "https://jobs.ashbyhq.com/acme-renamed/someone-else" }]), () => new Response("<html><title>Jobs</title></html>", { status: 200 }));
    expect((await fetchAshbyJob("acme", ID)).listingStatus).not.toBe("closed");
  });

  it("not on the board but the job page still shows the posting (unlisted) stays open", async () => {
    const ld = `<script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@type": "JobPosting", title: "Platform Engineer", description: "<p>Run Kubernetes.</p>", hiringOrganization: { name: "Acme" } })}</script>`;
    stub(() => board([{ id: "someone-else", title: "Other", jobUrl: "https://jobs.ashbyhq.com/acme/someone-else" }]), () => new Response(`<html><head>${ld}</head></html>`, { status: 200 }));
    const job = await fetchAshbyJob("acme", ID);
    expect(job.listingStatus).toBe("open");
    expect(job.title).toBe("Platform Engineer");
  });

  it("not on the board and the page fetch fails is not closed", async () => {
    stub(() => board([{ id: "someone-else", title: "Other" }]), () => new Response("oops", { status: 503 }));
    expect((await fetchAshbyJob("acme", ID)).listingStatus).not.toBe("closed");
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
