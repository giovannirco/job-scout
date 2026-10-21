import { describe, expect, it } from "vitest";
import {
  canonicalCompanySlug,
  COMPANY_SLUG_ALIASES,
  isPrototypeSlug,
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

describe("company slug lookups ignore Object.prototype", () => {
  it.each(["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf", "Constructor"])("%s resolves to a plain string slug", (name) => {
    const slug = canonicalCompanySlug(name);
    expect(typeof slug).toBe("string");
    expect(slug).toBe(normalizeCompanyKey(name));
    expect(isPrototypeSlug(slug)).toBe(false);
    expect(preferredCompanyName(name, name)).toBe(name);
  });

  it("keeps real aliases", () => {
    expect(canonicalCompanySlug("Gym Pass")).toBe("wellhub");
    expect(COMPANY_SLUG_ALIASES.has("constructor")).toBe(false);
  });

  it("detects function-stringified slugs", () => {
    expect(isPrototypeSlug("function Object() { [native code] }")).toBe(true);
    expect(isPrototypeSlug("function-object-native-code-platform-engineer-ab12")).toBe(true);
    expect(isPrototypeSlug("constructor")).toBe(false);
    expect(isPrototypeSlug("function-health")).toBe(false);
  });
});
