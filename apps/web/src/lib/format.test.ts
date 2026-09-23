import { describe, expect, it } from "vitest";
import { countLabel, createdFromLabel, employmentLabel, jdChangedAt, money, questionStatusLabel } from "./format.js";

describe("jdChangedAt", () => {
  it("ignores a change stamp that is the first snapshot", () => {
    const at = "2026-09-23T18:00:00.000Z";
    expect(jdChangedAt(at, at)).toBeNull();
    expect(jdChangedAt(at, "2026-09-23T18:00:00.400Z")).toBeNull();
    expect(jdChangedAt(at, "2026-09-23T19:30:00.000Z")).toBe("2026-09-23T19:30:00.000Z");
  });
});

describe("money", () => {
  it("puts the currency mark on both ends of a range", () => {
    expect(money(140000, 180000, "USD")).toBe("$140k–$180k");
    expect(money(150000, 150000, "USD")).toBe("$150k");
  });
});

describe("employmentLabel", () => {
  it("turns schema.org enums into words", () => {
    expect(employmentLabel("FullTime")).toBe("Full-time");
    expect(employmentLabel("FULL_TIME")).toBe("Full-time");
    expect(employmentLabel("Part-time")).toBe("Part-time");
    expect(employmentLabel("Something else")).toBe("Something else");
  });
});

describe("createdFromLabel", () => {
  it("names the scanner instead of the stored source code", () => {
    expect(createdFromLabel("Created from scan:discovery")).toBe("Created from discovery");
    expect(createdFromLabel("Created from scan:greenhouse")).toBe("Created from Greenhouse");
    expect(createdFromLabel("Created from scan:remoteok")).toBe("Created from Remote OK");
    expect(createdFromLabel("Created from manual")).toBe("Added by hand");
    expect(createdFromLabel("First JD snapshot")).toBe("First JD snapshot");
  });
});

describe("questionStatusLabel", () => {
  it("does not call an unanswered question open", () => {
    expect(questionStatusLabel("open")).toBe("unanswered");
    expect(questionStatusLabel("answered")).toBe("answered");
    expect(questionStatusLabel("skipped")).toBe("skipped");
  });
});

describe("countLabel", () => {
  it("uses the singular for one", () => {
    expect(countLabel(1, "row")).toBe("1 row");
    expect(countLabel(121, "row")).toBe("121 rows");
    expect(countLabel(0, "event")).toBe("0 events");
  });
});
