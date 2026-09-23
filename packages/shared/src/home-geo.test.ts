import { describe, expect, it } from "vitest";
import { homeMarket, missesHomeMarket } from "./home-geo.js";

describe("home market", () => {
  it("reads a US city and ignores a blank or foreign profile", () => {
    expect(homeMarket("Austin, TX")).toBe("us");
    expect(homeMarket("")).toBeNull();
    expect(homeMarket("São Paulo")).toBeNull();
  });

  it("drops a country-locked remote role for Austin and keeps a US or open one", () => {
    const home = "Austin, TX";
    expect(missesHomeMarket("Remote, Poland", home)).toBe(true);
    expect(missesHomeMarket("Republic of Ireland (Remote)", home)).toBe(true);
    expect(missesHomeMarket("United Kingdom", home)).toBe(true);
    expect(missesHomeMarket("Brazil (Remote)", home)).toBe(true);
    expect(missesHomeMarket("Remote - APAC", home)).toBe(true);
    expect(missesHomeMarket("Remote · EMEA · Canada", home)).toBe(true);
    expect(missesHomeMarket("Poland · Brazil · Sweden · Colombia", home)).toBe(true);
    expect(missesHomeMarket("Remote", home)).toBe(false);
    expect(missesHomeMarket("Remote - USA", home)).toBe(false);
    expect(missesHomeMarket("Remote, Canada · Remote, United States", home)).toBe(false);
    expect(missesHomeMarket("Remote - Americas or EU", home)).toBe(false);
    expect(missesHomeMarket("Remote - EU - LATAM - NA", home)).toBe(false);
    expect(missesHomeMarket("Remote, Poland", "")).toBe(false);
  });
});
