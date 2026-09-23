import { describe, expect, it } from "vitest";
import { archiveReasonLabel } from "./gate-reason.js";

describe("archive reason label", () => {
  it("turns the stored gate code into a short phrase", () => {
    expect(archiveReasonLabel("left the title gate (title_exclude:ubuntu)")).toBe("excluded: ubuntu");
    expect(archiveReasonLabel("left the location gate (geo_home)")).toBe("outside your home market");
    expect(archiveReasonLabel("left the location gate (geo_block:onsite)")).toBe("location blocked: onsite");
    expect(archiveReasonLabel("listing_closed")).toBe("listing_closed");
  });
});
