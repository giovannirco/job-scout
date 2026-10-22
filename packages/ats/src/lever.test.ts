import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyListing } from "@job-scout/shared";
import { fetchJobFromUrl, leverWorkplaceType, listLeverBoard } from "./fetch.js";

/** Synthetic tenant and posting; the payload follows the public api.lever.co/v0/postings shape. */
const ID = "00000000-0000-4000-8000-00000000abcd";
const URL_ = `https://jobs.lever.co/acmepay/${ID}`;
const posting = (over: Record<string, unknown> = {}) => ({
  id: ID,
  text: "Senior Observability Engineer",
  hostedUrl: URL_,
  applyUrl: `${URL_}/apply`,
  workplaceType: "remote",
  categories: { location: "Exampleville", commitment: "Full-time", team: "Platform" },
  descriptionPlain: "Acme Pay runs payment rails for small merchants.",
  description: "<div>Acme Pay runs payment rails for small merchants.</div>",
  lists: [
    { text: "Responsibilities", content: "<li>Own the metrics and tracing platform</li><li>Define SLIs and SLOs</li>" },
    { text: "What We're Looking For", content: "<li>5+ years with Terraform</li>" },
    { text: "Bonus Points", content: "<li>Kubernetes</li>" },
  ],
  additionalPlain: "Office attendance applies only to residents of the Exampleville metro area.",
  additional: "<div>Office attendance applies only to residents of the Exampleville metro area.</div>",
  ...over,
});

afterEach(() => vi.unstubAllGlobals());

describe("Lever", () => {
  it("builds the JD from the description, every list and the closing section", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(posting()), { status: 200 })));
    const job = await fetchJobFromUrl(URL_);
    expect(job).toMatchObject({ provider: "lever", title: "Senior Observability Engineer", applyUrl: `${URL_}/apply`, externalIdentity: `lever:acmepay:${ID}` });
    const jd = job.descriptionText || "";
    expect(jd).toContain("payment rails");
    expect(jd).toContain("Responsibilities");
    expect(jd).toContain("Define SLIs and SLOs");
    expect(jd).toContain("5+ years with Terraform");
    expect(jd).toContain("Bonus Points");
    expect(jd).toContain("Exampleville metro area");
    expect(jd.indexOf("payment rails")).toBeLessThan(jd.indexOf("Responsibilities"));
    expect(jd.indexOf("Responsibilities")).toBeLessThan(jd.indexOf("Exampleville metro area"));
  });

  it("falls back to the HTML fields when the plain ones are missing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(posting({ descriptionPlain: undefined, additionalPlain: undefined })), { status: 200 })));
    const jd = (await fetchJobFromUrl(URL_)).descriptionText || "";
    expect(jd).toContain("payment rails");
    expect(jd).toContain("Own the metrics and tracing platform");
    expect(jd).toContain("Exampleville metro area");
    expect(jd).not.toMatch(/<div>|<li>/);
  });

  it("carries the ATS workplaceType, and a remote posting in a city stays remote", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(posting()), { status: 200 })));
    const job = await fetchJobFromUrl(URL_);
    expect(job.workplaceType).toBe("remote");
    expect(job.isRemote).toBe(true);
    const facts = classifyListing({ locationRaw: job.locationRaw, workplaceType: job.workplaceType, isRemote: job.isRemote, title: job.title, descriptionText: job.descriptionText });
    expect(facts.workplace).toBe("remote");
  });

  it("maps Lever workplace values", () => {
    expect(leverWorkplaceType("remote")).toBe("remote");
    expect(leverWorkplaceType("hybrid")).toBe("hybrid");
    expect(leverWorkplaceType("onSite")).toBe("onsite");
    expect(leverWorkplaceType("on-site")).toBe("onsite");
    expect(leverWorkplaceType("unspecified")).toBeUndefined();
    expect(leverWorkplaceType(undefined)).toBeUndefined();
  });

  it("board listing carries workplaceType too", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([
      { id: ID, text: "Senior Observability Engineer", hostedUrl: URL_, workplaceType: "remote", categories: { location: "Exampleville" } },
      { id: "00000000-0000-4000-8000-00000000abce", text: "Office Manager", hostedUrl: `${URL_}e`, workplaceType: "onSite", categories: { location: "Exampleville" } },
    ]), { status: 200 })));
    const { jobs } = await listLeverBoard("acmepay", "Acme Pay");
    expect(jobs.map(j => [j.workplaceType, j.isRemote])).toEqual([["remote", true], ["onsite", undefined]]);
  });
});
