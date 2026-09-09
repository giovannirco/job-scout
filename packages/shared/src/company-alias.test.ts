import { describe, expect, it } from "vitest";
import {
  canonicalCompanySlug,
  normalizeCompanyKey,
  preferredCompanyName,
} from "./company-alias.js";

describe("company-alias", () => {
  it("normalizes keys", () => {
    expect(normalizeCompanyKey("Wellhub (Gympass)")).toBe("wellhub-gympass");
    expect(normalizeCompanyKey("  Gym Pass ")).toBe("gym-pass");
  });

  it("maps wellhub/gympass variants to wellhub", () => {
    expect(canonicalCompanySlug("Wellhub (Gympass)")).toBe("wellhub");
    expect(canonicalCompanySlug("wellhub-gympass")).toBe("wellhub");
    expect(canonicalCompanySlug("gympass")).toBe("wellhub");
    expect(canonicalCompanySlug("Wellhub")).toBe("wellhub");
    expect(canonicalCompanySlug("Bitso")).toBe("bitso");
  });

  it("preferred display for wellhub", () => {
    expect(preferredCompanyName("Wellhub (Gympass)")).toBe("Wellhub");
    expect(preferredCompanyName("bitso", "Bitso")).toBe("Bitso");
  });
});
