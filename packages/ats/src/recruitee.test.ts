import { afterEach, describe, expect, it, vi } from "vitest";
import { isJobPostingUrl } from "@job-scout/shared";
import { detectAts } from "./detect.js";
import { fetchJobFromUrl } from "./fetch.js";

/** Synthetic tenant and offer; the payload follows the public /api/offers/{slug} shape. */
const URL_ = "https://acmepay.recruitee.com/o/platform-engineer-senior";
const offer = (over: Record<string, unknown> = {}) => ({
  offer: {
    id: 900001,
    slug: "platform-engineer-senior",
    title: "Platform Engineer (Senior)",
    status: "published",
    remote: true,
    city: "Remote ",
    country: "United States",
    company_name: "Acme Pay",
    description: "<h4>About Acme Pay</h4><p>We run payment rails for small merchants.</p>",
    requirements: "<p>Kubernetes, Terraform &amp; on-call</p>",
    salary: { min: "120000", max: "150000", currency: "USD", period: "year" },
    ...over,
  },
});

afterEach(() => vi.unstubAllGlobals());

describe("Recruitee", () => {
  it("detects company + offer slug instead of provider other", () => {
    expect(detectAts(URL_)).toMatchObject({ provider: "recruitee", boardToken: "acmepay", jobId: "platform-engineer-senior", confidence: "high" });
    expect(detectAts("https://www.recruitee.com/o/anything").provider).not.toBe("recruitee");
    expect(isJobPostingUrl(URL_)).toBe(true);
    expect(isJobPostingUrl("https://acmepay.recruitee.com/")).toBe(false);
  });

  it("reads the public offers API, never the marketing page", async () => {
    const fetchMock = vi.fn(async (_u: string, _init?: RequestInit) => new Response(JSON.stringify(offer()), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const job = await fetchJobFromUrl(URL_);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://acmepay.recruitee.com/api/offers/platform-engineer-senior");
    expect(job).toMatchObject({
      provider: "recruitee",
      title: "Platform Engineer (Senior)",
      company: "Acme Pay",
      url: URL_,
      listingStatus: "open",
      isRemote: true,
      locationRaw: "Remote",
      salaryRaw: "USD 120000-150000 year",
      externalIdentity: "recruitee:acmepay:platform-engineer-senior",
    });
    expect(job.descriptionText).toContain("payment rails");
    expect(job.descriptionText).toContain("Terraform & on-call");
  });

  it("404 or unpublished is closed; another offer's slug is a failed fetch", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
    expect((await fetchJobFromUrl(URL_)).listingStatus).toBe("closed");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(offer({ status: "closed" })), { status: 200 })));
    expect((await fetchJobFromUrl(URL_)).listingStatus).toBe("closed");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(offer({ slug: "other-offer" })), { status: 200 })));
    const other = await fetchJobFromUrl(URL_);
    expect(other.title).toBe("");
    expect((other.rawPayload as { fetchFailed?: string }).fetchFailed).toBe("slug_mismatch");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>not json</html>", { status: 200 })));
    expect(((await fetchJobFromUrl(URL_)).rawPayload as { fetchFailed?: string }).fetchFailed).toBe("bad_payload");
  });

  it("an on-site offer keeps city and country", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(offer({ remote: false, city: "Lisbon", country: "Portugal", salary: null })), { status: 200 })));
    const job = await fetchJobFromUrl(URL_);
    expect(job).toMatchObject({ locationRaw: "Lisbon, Portugal", isRemote: false });
    expect(job.salaryRaw).toBeUndefined();
  });
});
