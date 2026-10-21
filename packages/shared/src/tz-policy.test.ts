import { describe, expect, it } from "vitest";
import { geoClass, matchLabel, mergeListingClassify } from "./classify.js";
import { hardDisqualifierKinds } from "./archive-policy.js";
import {
  acceptableTzRangeOf,
  applyTzPolicy,
  evaluateGeoRequirement,
  isTimezoneOnlyRestriction,
  nonTzBlockers,
  stripTzPhrases,
} from "./tz-policy.js";

const RANGE = { min: -8, max: -3 };

describe("timezone policy: a timezone window alone never blocks", () => {
  it.each([
    "must reside UTC-8 to UTC-5",
    "US time zones/EST hours/PST overlap",
    "Americas, US time zones",
    "UTC-3 to UTC+3",
    "overlap between GMT and GMT-8",
  ])("overlapping window, no penalty: %s", (t) => {
    const v = evaluateGeoRequirement(t, RANGE);
    expect(v.block).toBe(false);
    expect(v.timezone).toBe(true);
    expect(v.penalty).toBe(0);
    expect(geoClass(t)).not.toBe("hard_geo");
  });

  it.each(["EMEA tz only", "APAC hours"])("outside the profile range is a soft penalty, never a block: %s", (t) => {
    const v = evaluateGeoRequirement(t, RANGE);
    expect(v.block).toBe(false);
    expect(v.penalty).toBe(0.5);
    expect(geoClass(t)).not.toBe("hard_geo");
  });

  it.each(["EMEA tz only", "APAC hours"])("without a profile range a window only informs: %s", (t) => {
    const v = evaluateGeoRequirement(t);
    expect(v.timezone).toBe(true);
    expect(v.penalty).toBe(0);
  });

  it.each([
    ["must reside in US / US work auth", ["residency", "work_authorization"]],
    ["Remote - USA", ["residency"]],
    ["Remote (Canada)", ["residency"]],
    ["onsite/hybrid Berlin", ["onsite"]],
  ])("blocks: %s", (t, kinds) => {
    const v = evaluateGeoRequirement(t);
    expect(v.block).toBe(true);
    expect(v.blockers).toEqual(expect.arrayContaining(kinds as string[]));
    expect(geoClass(t)).toBe("hard_geo");
  });

  it("Remote - USA with a contractor path is not a residency block", () => {
    expect(nonTzBlockers("Remote - USA, contractors welcome")).not.toContain("residency");
  });

  it("a city office stays hard_geo even next to a timezone note", () => {
    expect(geoClass("London", "remote", "EST hours")).toBe("hard_geo");
    expect(geoClass("Remote - USA (EST hours)")).toBe("hard_geo");
  });

  it("a remote infrastructure role with a GMT window stays a match", () => {
    expect(matchLabel({ title: "Infrastructure Engineer", location: "Remote", extra: "overlap between GMT and GMT-8" })).toBe("match");
  });

  it("listing_classify cannot tighten to hard_geo on a timezone-only note", () => {
    const r = mergeListingClassify(
      { workplace: "remote", geoClass: "ambiguous_remote", locationRaw: "Remote" },
      { geoClass: "hard_geo", geoNote: "US time zones (EST hours)", evidence: "must work EST hours" },
    );
    expect(r.geoClass).toBe("ambiguous_remote");
  });

  it("acceptableTzRange is unset by default and read from profile metadata", () => {
    expect(acceptableTzRangeOf(undefined)).toBeNull();
    expect(acceptableTzRangeOf({})).toBeNull();
    expect(acceptableTzRangeOf({ acceptableTzRange: { min: -6, max: 0 } })).toEqual({ min: -6, max: 0 });
    expect(acceptableTzRangeOf({ acceptableTzRange: { min: "-5", max: "1" } })).toEqual({ min: -5, max: 1 });
    expect(acceptableTzRangeOf({ acceptableTzRange: { min: 3, max: 1 } })).toBeNull();
    expect(acceptableTzRangeOf({ acceptableTzRange: { min: null, max: 1 } })).toBeNull();
    expect(acceptableTzRangeOf({ acceptableTzRange: { min: -30, max: 1 } })).toBeNull();
  });

  it("isTimezoneOnlyRestriction", () => {
    expect(isTimezoneOnlyRestriction("triage fail 2.4: requires US time zones")).toBe(true);
    expect(isTimezoneOnlyRestriction("must be authorized to work in the US; EST hours")).toBe(false);
    expect(isTimezoneOnlyRestriction("Must reside in the US")).toBe(false);
  });

  it("stripTzPhrases keeps the country but drops the timezone wording", () => {
    expect(stripTzPhrases("US time zones only")).toBe("only");
    expect(stripTzPhrases("Must reside in Canada, EST hours")).toBe("Must reside in Canada,");
  });

  it("the archive policy does not read 'US time zones only' as residency", () => {
    expect(hardDisqualifierKinds("US time zones only")).toEqual([]);
    expect(hardDisqualifierKinds("US only, EST hours")).toEqual(["residency"]);
  });
});

describe("applyTzPolicy on triage output", () => {
  const base = { score: 2.4, archetype: 4.5, comp: 4, location: 1, cvMatch: 4, softFlags: [] as string[], locationNote: "US time zones", oneLiner: "x" };

  it("drops a timezone-only hardDq and recomputes the score", () => {
    const r = applyTzPolicy({ ...base, hardDq: ["Requires overlap between GMT and GMT-8"] }, RANGE);
    expect(r.adjusted).toBe(true);
    expect(r.out.hardDq).toEqual([]);
    expect(r.penalty).toBe(0);
    expect(r.out.location).toBe(4);
    expect(r.out.score).toBeGreaterThan(3.5);
  });

  it("outside the profile range costs at most 0.5", () => {
    const r = applyTzPolicy({ ...base, locationNote: "APAC hours", hardDq: ["APAC hours required"] }, RANGE);
    expect(r.out.hardDq).toEqual([]);
    expect(r.penalty).toBe(0.5);
    expect(r.out.softFlags).toEqual(["timezone window outside UTC-8..UTC-3 (soft)"]);
    const noTz = 4.5 * 0.35 + 4 * 0.25 + 4 * 0.25 + 4 * 0.15;
    expect(r.out.score).toBe(Math.round((noTz - 0.5) * 10) / 10);
  });

  it("without a profile range the window is dropped with no flag and no penalty", () => {
    const r = applyTzPolicy({ ...base, locationNote: "APAC hours", hardDq: ["APAC hours required"] });
    expect(r.out.hardDq).toEqual([]);
    expect(r.penalty).toBe(0);
    expect(r.out.softFlags).toEqual([]);
    expect(r.out.score).toBe(Math.round((4.5 * 0.35 + 4 * 0.25 + 4 * 0.25 + 4 * 0.15) * 10) / 10);
  });

  it("keeps real blockers and their score", () => {
    const r = applyTzPolicy({ ...base, hardDq: ["Must reside in the US and be authorized to work", "EST hours"] }, RANGE);
    expect(r.out.hardDq).toEqual(["Must reside in the US and be authorized to work"]);
    expect(r.removed).toEqual(["EST hours"]);
    expect(r.out.score).toBe(2.4);
  });

  it("leaves output without timezone wording untouched", () => {
    const input = { ...base, locationNote: "remote", hardDq: ["Requires active security clearance"] };
    const r = applyTzPolicy(input, RANGE);
    expect(r.adjusted).toBe(false);
    expect(r.out).toBe(input);
  });
});
