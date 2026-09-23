import { describe, expect, it } from "vitest";
import { countLabel, jdChangedAt } from "./format.js";

describe("jdChangedAt", () => {
  it("ignores a change stamp that is the first snapshot", () => {
    const at = "2026-09-23T18:00:00.000Z";
    expect(jdChangedAt(at, at)).toBeNull();
    expect(jdChangedAt(at, "2026-09-23T18:00:00.400Z")).toBeNull();
    expect(jdChangedAt(at, "2026-09-23T19:30:00.000Z")).toBe("2026-09-23T19:30:00.000Z");
  });
});

describe("countLabel", () => {
  it("uses the singular for one", () => {
    expect(countLabel(1, "row")).toBe("1 row");
    expect(countLabel(121, "row")).toBe("121 rows");
    expect(countLabel(0, "event")).toBe("0 events");
  });
});
