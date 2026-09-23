import { describe, expect, it } from "vitest";
import { fitsHomeMarket, homeMarket, missesHomeMarket } from "./home-geo.js";

describe("home market", () => {
  it("reads a US city and ignores a blank or foreign profile", () => {
    expect(homeMarket("Austin, TX")).toBe("us");
    expect(homeMarket("São Paulo")).toBe("br");
    expect(homeMarket("")).toBeNull();
    expect(homeMarket("London")).toBeNull();
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
    expect(missesHomeMarket("Remote - USA", "São Paulo")).toBe(true);
    expect(missesHomeMarket("Remote, Poland", "São Paulo")).toBe(true);
    expect(missesHomeMarket("Brazil (Remote)", "São Paulo")).toBe(false);
    expect(missesHomeMarket("Remote", "São Paulo")).toBe(false);
    expect(missesHomeMarket("Remote, Poland", "London")).toBe(false);
    expect(missesHomeMarket("Sao Paulo", "Austin, TX")).toBe(true);
    expect(missesHomeMarket("APJ", "Austin, TX")).toBe(true);
  });

  it("treats a US restriction as a fit for Austin and a foreign one as not", () => {
    expect(fitsHomeMarket("hard_geo", "Remote - USA", "Austin, TX")).toBe(true);
    expect(fitsHomeMarket("hard_geo", "Remote, Canada · Remote, United States", "Austin, TX")).toBe(true);
    expect(fitsHomeMarket("hard_geo", "Remote, Poland", "Austin, TX")).toBe(false);
    expect(fitsHomeMarket("hard_geo", "Remote - USA", "")).toBe(false);
    expect(fitsHomeMarket("worldwideish", "Remote - USA", "Austin, TX")).toBe(false);
  });
});
