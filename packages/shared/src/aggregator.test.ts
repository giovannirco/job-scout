import { describe, expect, it } from "vitest";
import { aggregatorHost, cleanEmployerCandidate, extractAggregatorEmployer } from "./aggregator.js";

const ld = (org: unknown) => `<script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@type": "JobPosting", title: "Senior Platform Engineer", hiringOrganization: org })}</script>`;

describe("aggregatorHost", () => {
  it("recognizes known aggregator hosts and ignores direct postings", () => {
    expect(aggregatorHost("https://jobgether.com/offer/abc123-senior-platform-engineer")).toBe("jobgether.com");
    expect(aggregatorHost("https://www.weworkremotely.com/remote-jobs/x")).toBe("weworkremotely.com");
    expect(aggregatorHost("https://job-boards.greenhouse.io/globex/jobs/1")).toBeNull();
    expect(aggregatorHost("https://notjobgether.com/x")).toBeNull();
    expect(aggregatorHost("not a url")).toBeNull();
  });
});

describe("extractAggregatorEmployer", () => {
  it("prefers a JSON-LD hiringOrganization that is not the aggregator", () => {
    expect(extractAggregatorEmployer({ html: ld({ "@type": "Organization", name: "Globex Labs" }) })).toEqual({ company: "Globex Labs", via: "json_ld" });
    expect(extractAggregatorEmployer({ html: ld({ name: "Jobgether" }) })).toBeNull();
    expect(extractAggregatorEmployer({ html: ld("Initech") })).toEqual({ company: "Initech", via: "json_ld" });
  });

  it("reads '<role> at <company>' and '<company> is hiring' titles", () => {
    expect(extractAggregatorEmployer({ html: "<title>Senior Platform Engineer at Globex Labs | Jobgether</title>", title: "Senior Platform Engineer" })).toEqual({ company: "Globex Labs", via: "title" });
    expect(extractAggregatorEmployer({ titleCandidates: ["Initech is hiring a Site Reliability Engineer"] })).toEqual({ company: "Initech", via: "title" });
    expect(extractAggregatorEmployer({ title: "Senior Platform Engineer at Remote" })).toBeNull();
  });

  it("reads 'on behalf of <Company>' but not anonymized partners", () => {
    expect(extractAggregatorEmployer({ text: "This position is posted on behalf of Globex Labs. Operate Kubernetes." })).toEqual({ company: "Globex Labs", via: "text" });
    expect(extractAggregatorEmployer({ text: "This position is posted by Jobgether on behalf of a partner company." })).toBeNull();
    expect(extractAggregatorEmployer({ text: "Operate Kubernetes in production." })).toBeNull();
  });

  it("rejects generic or aggregator names", () => {
    expect(cleanEmployerCandidate("Confidential")).toBeNull();
    expect(cleanEmployerCandidate("our client")).toBeNull();
    expect(cleanEmployerCandidate("Remotive")).toBeNull();
    expect(cleanEmployerCandidate("Globex Labs.")).toBe("Globex Labs");
  });
});
