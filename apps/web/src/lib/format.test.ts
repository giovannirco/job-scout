import { describe, expect, it } from "vitest";
import { ago, companySite, countLabel, createdFromLabel, departmentLabel, employmentLabel, jdChangedAt, money, multiAnswerValues, questionStatusLabel, readableJd, sourceLabel, toggleMultiAnswer } from "./format.js";

describe("ago", () => {
  it("uses years once a date is at least two years old", () => {
    const old = new Date(Date.now() - 800 * 86_400_000).toISOString();
    expect(ago(old)).toBe("2y");
    const recent = new Date(Date.now() - 40 * 86_400_000).toISOString();
    expect(ago(recent)).toBe("40d");
  });
});

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

describe("companySite", () => {
  it("uses the company domain on a careers link and skips an ATS board", () => {
    expect(companySite(null, "https://tailscale.com/careers")).toEqual({ href: "https://tailscale.com", label: "tailscale.com" });
    expect(companySite("https://www.stripe.com", null)).toEqual({ href: "https://www.stripe.com", label: "stripe.com" });
    expect(companySite(null, "https://jobs.ashbyhq.com/temporal")).toBeNull();
  });
});

describe("toggleMultiAnswer", () => {
  it("keeps several choices and preserves the option order", () => {
    const options = ["Canada", "Germany", "United States"];
    const one = toggleMultiAnswer("", "Germany", options);
    expect(one).toBe("Germany");
    expect(toggleMultiAnswer(one, "Canada", options)).toBe("Canada\nGermany");
    expect(toggleMultiAnswer("Canada\nGermany", "Germany", options)).toBe("Canada");
    expect(multiAnswerValues("Canada\nGermany")).toEqual(["Canada", "Germany"]);
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

  it("names a stored source the same way", () => {
    expect(sourceLabel("scan:discovery")).toBe("discovery");
    expect(sourceLabel("scan:ashby")).toBe("Ashby");
    expect(sourceLabel("manual")).toBe("added by hand");
  });
});

describe("questionStatusLabel", () => {
  it("does not call an unanswered question open", () => {
    expect(questionStatusLabel("open")).toBe("unanswered");
    expect(questionStatusLabel("answered")).toBe("answered");
    expect(questionStatusLabel("skipped")).toBe("skipped");
  });
});

describe("departmentLabel", () => {
  it("keeps a team name and drops a generic engineering label", () => {
    expect(departmentLabel(["Engineering"])).toBeNull();
    expect(departmentLabel(["Enterprise Applications"])).toBe("Enterprise Applications");
    expect(departmentLabel(["Engineering", "Engineering - Security"])).toBe("Engineering - Security");
  });
});

describe("readableJd", () => {
  it("collapses the blank runs boards leave between sections", () => {
    expect(readableJd("Intro\n\n\n\nWhat you will do\n")).toBe("Intro\n\nWhat you will do");
  });
});

describe("countLabel", () => {
  it("uses the singular for one", () => {
    expect(countLabel(1, "row")).toBe("1 row");
    expect(countLabel(121, "row")).toBe("121 rows");
    expect(countLabel(0, "event")).toBe("0 events");
  });
});
