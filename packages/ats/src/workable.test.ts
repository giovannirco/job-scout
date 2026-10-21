import { afterEach, describe, expect, it, vi } from "vitest";
import { detectAts } from "./detect.js";
import { fetchJobFromUrl } from "./fetch.js";

afterEach(() => vi.unstubAllGlobals());

// Synthetic account and shortcode; the response shape follows the public v2 job endpoint.
const URL_ = "https://apply.workable.com/acme-example/j/AB12CD34EF/";
const API = "https://apply.workable.com/api/v2/accounts/acme-example/jobs/AB12CD34EF";
const apiJob = {
  shortcode: "AB12CD34EF",
  title: "Senior Site Reliability Engineer",
  description: "<p>Run the Kubernetes platform behind our payments product.</p>",
  requirements: "<ul><li>5+ years operating Kubernetes</li><li>Terraform</li></ul>",
  benefits: "<p>Salary: $140,000 - $170,000 per year. Remote budget.</p>",
  location: { city: "Lisbon", region: "Lisbon", country: "Portugal", countryCode: "PT" },
  remote: true,
  workplace: "remote",
  type: "full",
  department: ["Engineering"],
  state: "published",
  published: "2026-10-01T10:00:00.000Z",
};

describe("Workable", () => {
  it("detects account + shortcode, the account board root, and the legacy hosted page", () => {
    expect(detectAts(URL_)).toMatchObject({ provider: "workable", boardToken: "acme-example", jobId: "AB12CD34EF", confidence: "high" });
    expect(detectAts("https://apply.workable.com/acme-example/")).toMatchObject({ provider: "workable", boardToken: "acme-example", jobId: undefined });
    expect(detectAts("https://acme-example.workable.com/j/AB12CD34EF")).toMatchObject({ provider: "workable", boardToken: "acme-example", jobId: "AB12CD34EF" });
    // Workable's job search names no account: never treat "view" as a board token.
    const search = detectAts("https://jobs.workable.com/view/AB12CD34EF/senior-sre-acme-example");
    expect(search).toMatchObject({ provider: "workable", jobId: "AB12CD34EF" });
    expect(search.boardToken).toBeUndefined();
  });

  it("reads the full JD from the public job API instead of the title-only page", async () => {
    const fetchMock = vi.fn(async (_u: string, _init?: RequestInit) => new Response(JSON.stringify(apiJob), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const job = await fetchJobFromUrl(URL_);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(API);
    expect(job).toMatchObject({
      provider: "workable",
      boardToken: "acme-example",
      jobId: "AB12CD34EF",
      externalIdentity: "workable:acme-example:AB12CD34EF",
      title: "Senior Site Reliability Engineer",
      locationRaw: "Lisbon, Portugal",
      isRemote: true,
      workplaceType: "remote",
      employmentType: "Full-time",
      departments: ["Engineering"],
      listingStatus: "open",
      postedAt: "2026-10-01T10:00:00.000Z",
    });
    expect(job.descriptionText).toContain("5+ years operating Kubernetes");
    expect(job.descriptionText).toContain("Requirements");
    expect(job.salaryRaw).toMatch(/140000/);
  });

  it("404 from the API means closed; a closed state closes too", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
    expect((await fetchJobFromUrl(URL_)).listingStatus).toBe("closed");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ...apiJob, state: "archived" }), { status: 200 })));
    expect((await fetchJobFromUrl(URL_)).listingStatus).toBe("closed");
  });

  it("refuses an API answer for a different shortcode", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ...apiJob, shortcode: "ZZ99ZZ99ZZ" }), { status: 200 })));
    const job = await fetchJobFromUrl(URL_);
    expect(job.title).toBe("");
    expect((job.rawPayload as { fetchFailed?: string }).fetchFailed).toBe("job_id_mismatch");
  });

  it("falls back to the generic page path when the API fails", async () => {
    const page = `<html><head><title>Platform Engineer - Acme Example</title>
      <script type="application/ld+json">${JSON.stringify({ "@type": "JobPosting", title: "Platform Engineer", description: "<p>Operate Kubernetes clusters, own Terraform modules and the on-call rotation for a payments platform.</p>" })}</script>
      </head><body></body></html>`;
    const fetchMock = vi.fn(async (u: string) => (String(u).includes("/api/v2/") ? new Response("busy", { status: 503 }) : new Response(page, { status: 200 })));
    vi.stubGlobal("fetch", fetchMock);
    const job = await fetchJobFromUrl(URL_);
    expect(job).toMatchObject({ provider: "workable", boardToken: "acme-example", jobId: "AB12CD34EF", title: "Platform Engineer" });
    expect(job.descriptionText).toContain("Terraform modules");
    expect((job.rawPayload as { apiFallback?: string }).apiFallback).toMatch(/503/);
  });

  it("decodes named entities in the JD sections", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ...apiJob, description: "<p>Op&eacute;rations &agrave; distance, s&eacute;curit&eacute; &amp; fiabilit&eacute;.</p>" }), { status: 200 })));
    const job = await fetchJobFromUrl(URL_);
    expect(job.descriptionText).toContain("Opérations à distance, sécurité & fiabilité.");
    expect(job.descriptionText).not.toMatch(/&[a-z]+;/i);
  });
});
