import { describe, expect, it } from "vitest";
import { canonicalExternalIdentity, cleanLocation, decisionTitle, employerFromPosting, isJobPostingUrl, listingCompany, normalizePostingUrl, requisitionId } from "./position-identity.js";
import { geoClass } from "./classify.js";
import { isNoiseJobTitle, isPlaceholderAtsUrl } from "./listing-title.js";

describe("posting identity and eligibility", () => {
  it.each([
    ["AMER", "worldwideish"], ["SAMER", "worldwideish"], ["NAMER", "hard_geo"],
    ["Bogota, Colombia", "hard_geo"], ["Chile, Remote", "hard_geo"],
    ["Rio de Janeiro, Rio de Janeiro", "brazil_friendly"], ["Remoto", "ambiguous_remote"], ["All", "ambiguous_remote"],
    ["Fully remote, US only", "hard_geo"], ["Remote, Brazil · Mexico", "brazil_friendly"],
  ])("classifies %s as %s", (location, expected) => expect(geoClass(location)).toBe(expected));

  it("tells a single opening from a careers root", () => {
    expect(isJobPostingUrl("https://jobs.ashbyhq.com/airbyte/b59bbc91-fb77-4a08-9c47-0fca7f755942")).toBe(true);
    expect(isJobPostingUrl("https://job-boards.greenhouse.io/alpaca/jobs/6194973004")).toBe(true);
    expect(isJobPostingUrl("https://stripe.com/jobs/search?gh_jid=8197891")).toBe(true);
    expect(isJobPostingUrl("https://stripe.com/jobs")).toBe(false);
    expect(isJobPostingUrl("https://www.elastic.co/careers")).toBe(false);
  });

  it("normalizes aliases and tracking without destroying job query IDs", () => {
    expect(normalizePostingUrl("http://boards.greenhouse.io/gympass/jobs/123/?utm_source=x#apply"))
      .toBe("https://job-boards.greenhouse.io/wellhub/jobs/123");
    expect(normalizePostingUrl("https://careers.acme.test/?jobId=123&utm_medium=y")).toContain("jobId=123");
    expect(canonicalExternalIdentity("greenhouse:gympass:123")).toBe("greenhouse:wellhub:123");
  });
  it("treats gh_jid / ashby_jid as canonical when the path already names the job", () => {
    const gh = "https://job-boards.greenhouse.io/acmepay/jobs/4012345";
    expect(normalizePostingUrl(`${gh}?gh_jid=4012345`)).toBe(gh);
    expect(normalizePostingUrl("https://boards.greenhouse.io/acmepay?gh_jid=4012345")).toBe(gh);
    expect(normalizePostingUrl(`${gh}?gh_jid=4012345&gh_src=abc`)).toBe(normalizePostingUrl(gh));
    expect(normalizePostingUrl("https://careers.acme.test/jobs/4012345?gh_jid=4012345")).toBe("https://careers.acme.test/jobs/4012345");
    expect(normalizePostingUrl("https://careers.acme.test/openings/c0ffee00-abcd?ashby_jid=c0ffee00-abcd")).toBe("https://careers.acme.test/openings/c0ffee00-abcd");
    // On a vanity page whose path carries no id the param is the only identity: keep it.
    expect(normalizePostingUrl("https://careers.acme.test/open-roles?gh_jid=4012345")).toBe("https://careers.acme.test/open-roles?gh_jid=4012345");
    expect(normalizePostingUrl("https://careers.acme.test/open-roles?gh_jid=4012345")).not.toBe(normalizePostingUrl("https://careers.acme.test/open-roles?gh_jid=4012346"));
  });
  it("keeps levels and requisitions distinct", () => {
    expect(decisionTitle("Senior SRE - Remote")).toBe(decisionTitle("Sr. SRE (Brazil)"));
    expect(decisionTitle("Senior SRE")).not.toBe(decisionTitle("SRE"));
    expect(decisionTitle("Staff Backend Engineer - Databases - Analytics | UK | Remote"))
      .toBe(decisionTitle("Staff Backend Engineer - Databases Analytics | Spain | Remote"));
    expect(decisionTitle("Senior Backend Engineer - Databases - Analytics | Germany | Remote"))
      .not.toBe(decisionTitle("Staff Backend Engineer - Databases - Analytics | Germany | Remote"));
    expect(decisionTitle("Senior Backend Software Engineer | IDX Team")).toBe("senior backend software engineer idx team");
    expect(requisitionId("Req R0042, Remote")).toBe("R0042");
    expect(requisitionId("Requisition ID: 1524")).toBe("1524");
    expect(requisitionId("We require 5 years")).toBeNull();
  });
  it("keeps the employer when the board is an aggregator", () => {
    expect(listingCompany("Evolve", "Remote OK")).toBe("Evolve");
    expect(listingCompany("Remote OK", "Remote OK")).toBe("Remote OK");
    expect(listingCompany("", "Datadog")).toBe("Datadog");
  });

  it("rejects fixtures and junk while accepting SRE", () => {
    for (const url of ["https://jobs.ashbyhq.com/railway/example", "https://linkedin.com/jobs/view/clip-gauntlet-demo", "https://linkedin.com/jobs/view/critic-unparsed-20260904", "https://example.com/jobs/123"]) expect(isPlaceholderAtsUrl(url)).toBe(true);
    for (const title of ["", "Okau", "Qzuh", "Msi3"]) expect(isNoiseJobTitle(title)).toBe(true);
    expect(isNoiseJobTitle("SRE")).toBe(false);
    expect(isPlaceholderAtsUrl("https://jobs.ashbyhq.com/demo-company/abc123")).toBe(false);
  });
  it("recovers WWR employers only at a proven title boundary", () => {
    expect(employerFromPosting("https://weworkremotely.com/remote-jobs/examplesoft-cloud-engineer-ii-ops", "Cloud Engineer II (Ops)")).toBe("Examplesoft");
    expect(employerFromPosting("https://weworkremotely.com/remote-jobs/examplesoft-something-else", "Cloud Engineer")).toBeNull();
    expect(cleanLocation("LATAM · [object Object] · Brazil")).toBe("LATAM · Brazil");
  });
});
