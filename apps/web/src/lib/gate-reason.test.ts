import { describe, expect, it } from "vitest";
import { gateReasonLabel } from "./gate-reason.js";

describe("gate reason label", () => {
  it("turns machine reasons into a sentence a new user can read", () => {
    expect(gateReasonLabel("title_no_include")).toBe("title not in your roles");
    expect(gateReasonLabel("title_exclude:new grad")).toBe("excluded: new grad");
    expect(gateReasonLabel("stale:20d")).toBe("older than the age limit (20d)");
    expect(gateReasonLabel("geo_block:hybrid")).toBe("location blocked: hybrid");
    expect(gateReasonLabel(null)).toBe("—");
  });
});
