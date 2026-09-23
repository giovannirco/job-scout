import { describe, expect, it } from "vitest";
import { likeContains, searchWords } from "./search.js";

describe("searchWords", () => {
  it("ignores a dash between the words a person typed", () => {
    expect(searchWords("New Markets EU")).toEqual(["new", "markets", "eu"]);
    expect(searchWords("New Markets - EU")).toEqual(["new", "markets", "eu"]);
  });

  it("keeps percent signs literal in the pattern", () => {
    expect(likeContains("100%")).toBe("%100\\%%");
  });
});
