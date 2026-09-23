import { describe, expect, it } from "vitest";
import { familyLocationLabel } from "./pipeline-location.js";

describe("family location label", () => {
  it("names the opened posting and how many other places share the role", () => {
    const label = familyLocationLabel(["Spain", "Portugal", "Ireland"]);
    expect(label).toEqual({ text: "Spain +2", title: "Spain, Portugal, Ireland" });
  });

  it("keeps a single location as itself", () => {
    expect(familyLocationLabel(["Canada"])).toEqual({ text: "Canada", title: "Canada" });
    expect(familyLocationLabel([], "Seattle, WA")).toEqual({ text: "Seattle, WA", title: "Seattle, WA" });
  });

  it("is empty when nothing was stored", () => {
    expect(familyLocationLabel([null, "  "], null)).toBeNull();
  });
});
