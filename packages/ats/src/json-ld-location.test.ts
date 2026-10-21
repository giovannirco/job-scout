import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyListing } from "@job-scout/shared";
import { fetchAshbyJob, jsonLdPlace } from "./fetch.js";

afterEach(() => vi.unstubAllGlobals());

describe("schema.org JobPosting location", () => {
  it("TELECOMMUTE with applicantLocationRequirements is remote in every listed country", () => {
    const place = jsonLdPlace({
      jobLocationType: "TELECOMMUTE",
      applicantLocationRequirements: [
        { "@type": "Country", name: "Argentina" },
        { "@type": "Country", name: "Mexico" },
        { "@type": "Country", name: "Brazil" },
      ],
      jobLocation: { "@type": "Place", address: { addressLocality: "Mexico City", addressCountry: "MX" } },
    });
    expect(place).toEqual({ locationRaw: "Remote · Argentina · Mexico · Brazil", workplaceType: "remote", isRemote: true });
    const facts = classifyListing({ locationRaw: place.locationRaw, workplaceType: place.workplaceType, isRemote: place.isRemote });
    expect(facts.workplace).toBe("remote");
    expect(facts.geoClass).toBe("brazil_friendly");
  });

  it("a jobLocation with only a country (ISO code or name) is that country, not unknown", () => {
    expect(jsonLdPlace({ jobLocation: { "@type": "Place", address: { "@type": "PostalAddress", addressCountry: "BR" } } }).locationRaw).toBe("Brazil");
    expect(jsonLdPlace({ jobLocation: { address: { addressCountry: { "@type": "Country", name: "Portugal" } } } }).locationRaw).toBe("Portugal");
    const facts = classifyListing({ locationRaw: jsonLdPlace({ jobLocation: { address: { addressCountry: "BR" } } }).locationRaw });
    expect(facts.geoClass).toBe("brazil_friendly");
  });

  it("several jobLocations stay several places, with their country", () => {
    const place = jsonLdPlace({
      jobLocation: [
        { address: { addressLocality: "Buenos Aires", addressCountry: "AR" } },
        { address: { addressLocality: "Bogotá", addressCountry: "CO" } },
      ],
    });
    expect(place.locationRaw).toBe("Buenos Aires, Argentina · Bogotá, Colombia");
    expect(place.workplaceType).toBeUndefined();
  });

  it("a single applicantLocationRequirements object or string still counts", () => {
    expect(jsonLdPlace({ jobLocationType: ["TELECOMMUTE"], applicantLocationRequirements: { "@type": "Country", name: "Canada" } }).locationRaw).toBe("Remote · Canada");
    expect(jsonLdPlace({ applicantLocationRequirements: "Uruguay" }).locationRaw).toBe("Uruguay");
    expect(jsonLdPlace({})).toEqual({});
  });

  it("an Ashby page fallback carries the JSON-LD remote flag and country list", async () => {
    const id = "abcdef01-2222-4333-8444-abcdefabcdef";
    const ld = `<script type="application/ld+json">${JSON.stringify({
      "@context": "https://schema.org", "@type": "JobPosting", title: "Platform Engineer", description: "<p>Run Kubernetes.</p>",
      hiringOrganization: { name: "Example Co" }, jobLocationType: "TELECOMMUTE",
      applicantLocationRequirements: [{ "@type": "Country", name: "Chile" }, { "@type": "Country", name: "Peru" }],
    })}</script>`;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) =>
      String(input).startsWith("https://api.ashbyhq.com/posting-api/job-board/")
        ? new Response(JSON.stringify({ jobs: [] }), { status: 200 })
        : new Response(`<html><head>${ld}</head></html>`, { status: 200 })));
    const job = await fetchAshbyJob("example", id);
    expect(job).toMatchObject({ locationRaw: "Remote · Chile · Peru", workplaceType: "remote", isRemote: true });
  });
});
