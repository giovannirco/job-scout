import { describe, expect, it } from "vitest";
import {
  classifyListing,
  listingClassifyNeeded,
  mergeListingClassify,
  craftFamily,
  geoClass,
  remoteClass,
  isCraftMatch,
  isNoiseTitle,
  laneForEvent,
  matchLabel,
  canPageEvalRequest,
  selectFirstSeenDigestRows,
  quickScoreHint,
  titleInteresting,
} from "./classify.js";

describe("classify craft", () => {
  it("matches platform/sre/devops titles", () => {
    expect(isCraftMatch("Platform Engineer")).toBe(true);
    expect(isCraftMatch("Senior Site Reliability Engineer")).toBe(true);
    expect(isCraftMatch("Staff DevOps Engineer")).toBe(true);
    expect(titleInteresting("Kubernetes Platform Engineer")).toBe(true);
  });

  it("rejects noise titles", () => {
    expect(isNoiseTitle("Account Executive")).toBe(true);
    expect(isCraftMatch("Platform Account Executive")).toBe(false);
    expect(isCraftMatch("Product Manager")).toBe(false);
    expect(isCraftMatch("React Native Engineer")).toBe(false);
  });

  it("allows core eng when noise keywords collide carefully", () => {
    expect(isCraftMatch("Software Engineer")).toBe(false); // no TITLE_RE alone without platform keywords
    expect(isCraftMatch("Platform Engineer")).toBe(true);
  });

  it("craft_family buckets", () => {
    expect(craftFamily("Senior SRE")).toBe("sre");
    expect(craftFamily("Platform Engineer")).toBe("platform");
    expect(craftFamily("DevOps Engineer")).toBe("devops");
    expect(craftFamily("Observability Engineer")).toBe("observability");
    expect(craftFamily("AI Platform Engineer")).toBe("ai_infra");
    expect(craftFamily("Account Executive")).toBe("noise");
    expect(craftFamily("Staff Software Engineer")).toBe("software");
    expect(craftFamily("Senior Backend Engineer")).toBe("software");
    expect(craftFamily("Software Engineer, Observability")).toBe("observability");
  });
});

describe("geo_class", () => {
  it("classifies brazil / worldwide / hard / ambiguous", () => {
    expect(geoClass("Remote — Brazil")).toBe("brazil_friendly");
    expect(geoClass("LATAM remote")).toBe("brazil_friendly");
    expect(geoClass("Worldwide")).toBe("worldwideish");
    expect(geoClass("Remote — EMEA only")).toBe("hard_geo");
    expect(geoClass("US only remote")).toBe("hard_geo");
    expect(geoClass("Remote")).toBe("ambiguous_remote");
    expect(geoClass("")).toBe("unknown");
  });

  it("treats a US city list that also says remote as a US place", () => {
    expect(geoClass("US-Remote, Chicago, Seattle, San Francisco", "remote")).toBe("hard_geo");
    expect(geoClass("San Francisco · New York City · Seattle · US - Remote", "remote")).toBe("hard_geo");
    expect(geoClass("Remote-Friendly (Travel-Required) · San Francisco, CA · Seattle, WA", "remote")).toBe("hard_geo");
    expect(geoClass("United States (Remote) · Seattle, Washington · San Francisco, California", "remote")).toBe("hard_geo");
    expect(geoClass("Washington, District of Columbia · Canada (Remote) · United States (Remote)", "remote")).toBe("ambiguous_remote");
  });

  it("treats a remote multi-country list without only/must-reside as TZ overlap, not hard_geo", () => {
    const location =
      "United Kingdom · Hungary · Poland · South Africa · Portugal · Ireland · Romania";
    expect(geoClass(location, "remote")).toBe("ambiguous_remote");
    expect(
      classifyListing({
        locationRaw: location,
        workplaceType: "Remote",
        isRemote: true,
        company: "Primer",
      }).geoClass,
    ).toBe("ambiguous_remote");
  });

  it("keeps exclusivity language as hard_geo even on a country list", () => {
    expect(geoClass("United Kingdom, Ireland, Portugal only", "remote")).toBe("hard_geo");
  });

  it("treats a named country or US city as a place, not unknown", () => {
    for (const location of [
      "Spain",
      "Ireland",
      "Greece",
      "Portugal",
      "Poland",
      "Romania",
      "Australia",
      "Norway",
      "Seattle, WA",
      "San Francisco",
      "San Francisco, CA",
      "Bay Area, CA, United States of America",
      "New York, New York, USA",
      "Palo Alto, California, United States",
      "Melbourne, Australia",
      "Remote, Poland",
      "Remote - APAC",
    ]) {
      expect(geoClass(location), location).toBe("hard_geo");
    }
    expect(geoClass("San Francisco, CA · New York City, NY")).toBe("hard_geo");
    expect(geoClass("Germany · Portugal · France · Spain · Italy · The Netherlands")).toBe("hard_geo");
    expect(geoClass("San Francisco · London, UK")).toBe("hard_geo");
  });
});

describe("quick_score_hint", () => {
  it("bounds and ranks craft+geo", () => {
    const hi = quickScoreHint(
      "Platform Engineer",
      "Remote — Brazil",
      "",
      "Strike",
    );
    const lo = quickScoreHint("Account Executive", "US only", "", "Acme");
    expect(hi).toBeGreaterThanOrEqual(70);
    expect(hi).toBeLessThanOrEqual(100);
    expect(lo).toBeLessThan(30);
    expect(quickScoreHint("Junior SRE", "Remote")).toBeLessThan(
      quickScoreHint("Senior SRE", "Remote"),
    );
  });
});

describe("matchLabel (pager gate — never delete)", () => {
  it("labels Wellhub-class observability platform title as match", () => {
    expect(
      matchLabel({
        title: "Staff Platform Engineer Observability",
        location: "Remote",
      }),
    ).toBe("match");
  });

  it("labels Vinted-class Staff Engineer AI title unmatched but does not invent skip", () => {
    expect(
      matchLabel({
        title: "Staff Engineer, AI, Engineering Experience",
        location: "",
      }),
    ).toBe("unmatched");
  });

  it("treats empty geo on a craft title as geo_unknown not reject", () => {
    expect(matchLabel({ title: "Site Reliability Engineer" })).toBe("geo_unknown");
  });

  it("treats city hard_geo on a real SRE title as hard_geo_maybe", () => {
    expect(
      matchLabel({
        title: "Site Reliability Engineer",
        location: "London",
      }),
    ).toBe("hard_geo_maybe");
  });

  it("keeps human_skip override", () => {
    expect(
      matchLabel({
        title: "Platform Engineer",
        location: "Worldwide",
        override: "human_skip",
      }),
    ).toBe("human_skip");
  });

  it("ambiguous remote craft is match not hard lock", () => {
    expect(
      matchLabel({
        title: "Senior DevOps Engineer",
        location: "Remote",
      }),
    ).toBe("match");
  });
});

describe("canPageEvalRequest", () => {
  it("pages only match + eval_requested", () => {
    expect(canPageEvalRequest({ matchLabel: "match", evalRequested: true })).toBe(true);
    expect(canPageEvalRequest({ matchLabel: "match", evalRequested: false })).toBe(false);
    expect(canPageEvalRequest({ matchLabel: "unmatched", evalRequested: true })).toBe(false);
    expect(canPageEvalRequest({ matchLabel: "geo_unknown", evalRequested: true })).toBe(false);
  });
});

describe("selectFirstSeenDigestRows", () => {
  it("ignores re-observed still-open rows", () => {
    const since = new Date("2026-08-14T00:00:00.000Z");
    const rows = [
      {
        matchLabel: "match",
        createdAt: "2026-08-13T10:00:00.000Z",
        observedAt: "2026-08-14T18:00:00.000Z",
      },
      {
        matchLabel: "match",
        createdAt: "2026-08-14T06:00:00.000Z",
        observedAt: "2026-08-14T18:00:00.000Z",
      },
      {
        matchLabel: "unmatched",
        createdAt: "2026-08-14T07:00:00.000Z",
        observedAt: "2026-08-14T18:00:00.000Z",
      },
    ];
    expect(selectFirstSeenDigestRows(rows, since, "match")).toHaveLength(1);
    expect(selectFirstSeenDigestRows(rows, since, "unmatched")).toHaveLength(1);
  });
});

describe("lanes", () => {
  it("fit vs hard geo", () => {
    const fit = laneForEvent("SRE", "Brazil remote", "", { company: "Bitso" });
    expect(fit.lanes.fit).toBe(true);
    expect(fit.lanes.raw).toBe(true);

    const hard = laneForEvent("SRE", "EMEA only", "");
    expect(hard.lanes.fit).toBe(false);
    expect(hard.geo_class).toBe("hard_geo");
  });
});

describe("classifyListing", () => {
  it("treats company-name location plus Remote type as ambiguous remote", () => {
    const r = classifyListing({
      locationRaw: "Lightning Labs",
      workplaceType: "Remote",
      isRemote: true,
      company: "Lightning Labs",
    });
    expect(r.workplace).toBe("remote");
    expect(r.geoClass).toBe("ambiguous_remote");
    expect(r.locationDiscarded).toBe(true);
  });

  it("reads Remote from the title when ATS workplaceType is missing", () => {
    const r = classifyListing({
      locationRaw: "Lightning Labs",
      company: "Lightning Labs",
      title: "Platform Engineer (Remote)",
    });
    expect(r.workplace).toBe("remote");
    expect(r.geoClass).toBe("ambiguous_remote");
  });

  it("keeps US-only as hard_geo even when workplace is remote", () => {
    const r = classifyListing({
      locationRaw: "Remote — US only",
      workplaceType: "Remote",
      company: "Acme",
    });
    expect(r.workplace).toBe("remote");
    expect(r.geoClass).toBe("hard_geo");
    expect(r.locationDiscarded).toBe(false);
  });

  it("treats a named place with no remote marker as an office", () => {
    expect(classifyListing({ locationRaw: "Spain", company: "Elastic" }).workplace).toBe("onsite");
    expect(classifyListing({ locationRaw: "London, England", company: "Figma" }).workplace).toBe("onsite");
    expect(classifyListing({ locationRaw: "Seattle, WA", company: "Stripe" }).workplace).toBe("onsite");
    expect(classifyListing({ locationRaw: "San Francisco, CA · New York City, NY", company: "Anthropic" }).workplace).toBe("onsite");
    expect(classifyListing({ locationRaw: "Remote, Poland", workplaceType: "Remote", company: "GitLab" }).workplace).toBe("remote");
    expect(classifyListing({ locationRaw: "San Francisco", workplaceType: "Hybrid", company: "OpenAI" }).workplace).toBe("hybrid");
    expect(classifyListing({ locationRaw: "", company: "Acme" }).workplace).toBe("unknown");
    expect(classifyListing({ locationRaw: "Bay Area, CA, United States of America" }).workplace).toBe("onsite");
    expect(classifyListing({ locationRaw: "San Francisco, CA • New York, NY • United States" }).workplace).toBe("onsite");
    expect(classifyListing({ locationRaw: "Home based - Worldwide" }).workplace).toBe("remote");
    expect(classifyListing({ locationRaw: "San Francisco, CA • New York, NY • United States", title: "Software Engineer - Distributed Systems" }).workplace).toBe("onsite");
    expect(classifyListing({ locationRaw: "Lugano" }).workplace).toBe("onsite");
    expect(classifyListing({ locationRaw: "Sao Paulo" }).workplace).toBe("onsite");
    expect(classifyListing({ locationRaw: "Bucharest" }).workplace).toBe("onsite");
    expect(classifyListing({ locationRaw: "AMER" }).workplace).toBe("remote");
    expect(classifyListing({ locationRaw: "N/A" }).locationClean).toBe("");
    expect(classifyListing({ locationRaw: "Ontario, CAN" }).workplace).toBe("onsite");
    // A title word never makes a city remote; an ATS workplaceType of Remote does (the city still locks geo).
    expect(classifyListing({ locationRaw: "San Francisco", title: "Software Engineer, Distributed Data Systems" }).workplace).toBe("onsite");
    expect(classifyListing({ locationRaw: "San Francisco", workplaceType: "Remote", title: "Software Engineer, Distributed Data Systems" })).toMatchObject({ workplace: "remote", geoClass: "hard_geo" });
    expect(classifyListing({ locationRaw: "United States", workplaceType: "Remote" }).workplace).toBe("remote");
    expect(classifyListing({ locationRaw: "United States", isRemote: true }).workplace).toBe("remote");
    expect(classifyListing({ locationRaw: "Boston, Massachusetts, USA; New York, New York, USA", isRemote: true }).workplace).toBe("onsite");
    expect(classifyListing({ locationRaw: "Distributed" }).workplace).toBe("remote");
    expect(classifyListing({ locationRaw: "Distributed · Austin, TX · Atlanta, GA · Canada" }).workplace).toBe("remote");
    expect(classifyListing({ locationRaw: "", descriptionText: "Job ID: P1\n#LI-Remote" }).workplace).toBe("remote");
    expect(classifyListing({ locationRaw: "Poland · Brazil · Sweden · Colombia", company: "Kraken" }).workplace).toBe("unknown");
    expect(classifyListing({ locationRaw: "Menlo Park, California, United States" }).workplace).toBe("onsite");
  });

  it("keeps Brazil remote as brazil_friendly", () => {
    const r = classifyListing({
      locationRaw: "Remote — Brazil",
      workplaceType: "Remote",
      company: "QuintoAndar",
    });
    expect(r.workplace).toBe("remote");
    expect(r.geoClass).toBe("brazil_friendly");
  });
});

describe("listingClassifyNeeded", () => {
  it("is true when the location was the company name", () => {
    const r = classifyListing({
      locationRaw: "Lightning Labs",
      workplaceType: "Remote",
      isRemote: true,
      company: "Lightning Labs",
    });
    expect(r.locationDiscarded).toBe(true);
    expect(r.geoClass).toBe("ambiguous_remote");
    expect(listingClassifyNeeded(r)).toBe(true);
  });

  it("is false when workplace and geo are already clear and location is a real place", () => {
    const r = classifyListing({
      locationRaw: "Remote — Brazil",
      workplaceType: "Remote",
      company: "QuintoAndar",
    });
    expect(listingClassifyNeeded(r)).toBe(false);
  });
});

describe("mergeListingClassify", () => {
  it("cannot clear a deterministic hard_geo", () => {
    const m = mergeListingClassify(
      { workplace: "remote", geoClass: "hard_geo" },
      { workplace: "remote", geoClass: "worldwideish", geoNote: "mentions remote", evidence: "Fully remote" },
    );
    expect(m.geoClass).toBe("hard_geo");
  });

  it("lets the LLM tighten worldwideish/unknown/ambiguous_remote to hard_geo", () => {
    const m = mergeListingClassify(
      { workplace: "remote", geoClass: "worldwideish" },
      { workplace: "remote", geoClass: "hard_geo", evidence: "US only in JD" },
    );
    expect(m.geoClass).toBe("hard_geo");
  });

  it("does not let the LLM treat a multi-country remote TZ list as hard_geo", () => {
    const location =
      "United Kingdom · Hungary · Poland · South Africa · Portugal · Ireland · Romania";
    const m = mergeListingClassify(
      { workplace: "remote", geoClass: "ambiguous_remote", locationRaw: location },
      { workplace: "remote", geoClass: "hard_geo", evidence: "UK / EMEA country list" },
    );
    expect(m.geoClass).toBe("ambiguous_remote");
  });

  it("does not let the LLM replace brazil_friendly with hard_geo", () => {
    const m = mergeListingClassify(
      { workplace: "remote", geoClass: "brazil_friendly" },
      { geoClass: "hard_geo", evidence: "US only" },
    );
    expect(m.geoClass).toBe("brazil_friendly");
  });

  it("fills unknown workplace from the LLM and leaves a known workplace alone", () => {
    expect(
      mergeListingClassify({ workplace: "unknown", geoClass: "unknown" }, { workplace: "hybrid" }).workplace,
    ).toBe("hybrid");
    expect(
      mergeListingClassify({ workplace: "remote", geoClass: "worldwideish" }, { workplace: "onsite" }).workplace,
    ).toBe("remote");
  });
});

describe("geo/workplace misreads: structured data first, no escalation from weak signals", () => {
  it("a city location with an ATS workplaceType of Remote is remote, not onsite", () => {
    const r = classifyListing({ locationRaw: "São Paulo", workplaceType: "Remote", company: "Example Co" });
    expect(r).toMatchObject({ workplace: "remote", geoClass: "brazil_friendly", workplaceWeak: false });
    expect(classifyListing({ locationRaw: "Curitiba", workplaceType: "TELECOMMUTE" }).workplace).toBe("remote");
    // Structured onsite and hybrid stay locked.
    expect(classifyListing({ locationRaw: "São Paulo", workplaceType: "OnSite" }).workplace).toBe("onsite");
    expect(classifyListing({ locationRaw: "São Paulo", workplaceType: "Hybrid" }).workplace).toBe("hybrid");
  });

  it("a JD saying 'Remote in Brazil' overrides an office guessed from the city name", () => {
    const r = classifyListing({
      locationRaw: "São Paulo, Brazil",
      company: "Example Co",
      descriptionText: "About the role\nThis position is Remote in Brazil. You will run Kubernetes clusters.",
    });
    expect(r.workplace).toBe("remote");
    expect(r.geoClass).toBe("brazil_friendly");
    // Without any remote statement the city is still an office.
    expect(classifyListing({ locationRaw: "São Paulo, Brazil", descriptionText: "Join our team downtown." }).workplace).toBe("onsite");
    expect(classifyListing({ locationRaw: "Lisbon", descriptionText: "This is a Fully Remote role." }).workplace).toBe("remote");
    expect(classifyListing({ locationRaw: "Lisbon", descriptionText: "We are 100% Remote." }).workplace).toBe("remote");
    expect(classifyListing({ locationRaw: "Lisbon", descriptionText: "Work remote from the office twice a month." }).workplace).toBe("onsite");
    // An onsite statement for this role beats company-wide remote wording.
    const lisbon = classifyListing({ locationRaw: "Lisbon", descriptionText: "We are remote-first with teams across Latin America, but this role is onsite in Lisbon." });
    expect(lisbon.workplace).toBe("onsite");
    expect(lisbon.geoClass).toBe("hard_geo");
    // A hybrid requirement in the JD keeps it an office.
    expect(classifyListing({ locationRaw: "São Paulo, Brazil", descriptionText: "Fully remote culture, but this is a hybrid role with 3 days a week in the office." }).workplace).toBe("onsite");
  });

  it("a city office whose JD mentions remote work is weak and goes to the listing model", () => {
    const r = classifyListing({ locationRaw: "Lisbon", descriptionText: "We offer remote Fridays and a modern office." });
    expect(r).toMatchObject({ workplace: "onsite", workplaceWeak: true });
    expect(listingClassifyNeeded(r)).toBe(true);
    expect(mergeListingClassify(r, { workplace: "remote" }).workplace).toBe("remote");
    // A structured or explicit onsite is not weak.
    expect(classifyListing({ locationRaw: "Lisbon", workplaceType: "OnSite", descriptionText: "remote Fridays" }).workplaceWeak).toBe(false);
    expect(mergeListingClassify({ workplace: "onsite", geoClass: "hard_geo" }, { workplace: "remote" }).workplace).toBe("onsite");
  });

  it("a role open to Argentina, Mexico and Brazil stays multi-country, not one office or Mexico-only", () => {
    const r = classifyListing({ locationRaw: "Argentina, Mexico, Brazil", company: "Example Co" });
    expect(r.workplace).not.toBe("onsite");
    expect(r.geoClass).toBe("brazil_friendly");
    const remote = classifyListing({ locationRaw: "Argentina, Mexico, Brazil", workplaceType: "Remote" });
    expect(remote).toMatchObject({ workplace: "remote", geoClass: "brazil_friendly" });
    // The listing model cannot narrow the list to its first country.
    expect(mergeListingClassify({ ...remote, geoClass: "ambiguous_remote", locationRaw: "Argentina, Mexico, Brazil" }, { geoClass: "hard_geo", geoNote: "Mexico only" }).geoClass).toBe("ambiguous_remote");
    // An address is still one place.
    expect(classifyListing({ locationRaw: "Ontario, Canada" }).workplace).toBe("onsite");
    expect(classifyListing({ locationRaw: "Menlo Park, California, United States" }).workplace).toBe("onsite");
  });

  it("'fully remote' in an EU-only posting is region-remote, never worldwide", () => {
    expect(geoClass("Fully remote")).toBe("ambiguous_remote");
    expect(remoteClass("Fully remote")).toBe("ambiguous_remote");
    expect(remoteClass("Fully remote (EU)")).toBe("emea");
    expect(remoteClass("Fully remote, EU only")).toBe("eu_only");
    expect(remoteClass("Fully remote, US only")).toBe("us_only");
    const r = classifyListing({ locationRaw: "Fully remote (EU)", company: "Example Co" });
    expect(r.workplace).toBe("remote");
    expect(r.geoClass).not.toBe("worldwideish");
    expect(r.remoteClass).not.toBe("worldwide");
    // Worldwide wording is still worldwide.
    expect(geoClass("Remote - Worldwide")).toBe("worldwideish");
    // The model may tighten "fully remote" to hard_geo when the JD says EU only.
    expect(mergeListingClassify({ workplace: "remote", geoClass: "ambiguous_remote", locationRaw: "Fully remote" }, { geoClass: "hard_geo", evidence: "Candidates must reside in the EU" }).geoClass).toBe("hard_geo");
  });

  it("a LATAM-remote contract is neither onsite nor hard_geo", () => {
    const r = classifyListing({
      locationRaw: "Buenos Aires, Argentina",
      descriptionText: "Contract role. We hire remote contractors anywhere in Latin America; overlap with US Eastern time.",
    });
    expect(r.workplace).toBe("remote");
    expect(r.geoClass).toBe("brazil_friendly");
    expect(classifyListing({ locationRaw: "Latin America (Contract)" })).toMatchObject({ workplace: "remote", geoClass: "brazil_friendly" });
    expect(classifyListing({ locationRaw: "LATAM - Contractor" }).workplace).toBe("remote");
    // A LATAM note from the model is not a lock.
    expect(mergeListingClassify({ workplace: "remote", geoClass: "ambiguous_remote", locationRaw: "Remote" }, { geoClass: "hard_geo", geoNote: "must be located in LATAM" }).geoClass).toBe("ambiguous_remote");
    // A residency limit in the JD cancels the wider region.
    const us = classifyListing({ locationRaw: "Austin, TX", descriptionText: "Remote across the Americas. Must reside in the United States." });
    expect(us.geoClass).toBe("hard_geo");
  });

  it("the listing model never reaches hard_geo from a weak note", () => {
    const det = { workplace: "remote" as const, geoClass: "ambiguous_remote" as const, locationRaw: "Remote" };
    expect(mergeListingClassify(det, { geoClass: "hard_geo", geoNote: "mentions Germany" }).geoClass).toBe("ambiguous_remote");
    expect(mergeListingClassify(det, { geoClass: "hard_geo", geoNote: "fully remote" }).geoClass).toBe("ambiguous_remote");
    expect(mergeListingClassify(det, { geoClass: "hard_geo", geoNote: "Americas-based candidates" }).geoClass).toBe("ambiguous_remote");
    expect(mergeListingClassify(det, { geoClass: "hard_geo", evidence: "Remote role restricted to candidates in Germany" }).geoClass).toBe("hard_geo");
    expect(mergeListingClassify(det, { geoClass: "hard_geo", evidence: "Requires US work authorization" }).geoClass).toBe("hard_geo");
  });
});
