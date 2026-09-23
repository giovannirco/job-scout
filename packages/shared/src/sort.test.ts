import { describe, expect, it } from "vitest";
import { parseListSort } from "./sort.js";

describe("parseListSort", () => {
  const allowed = ["updated", "score", "company", "status", "first_seen", "title"] as const;

  it("parses field_dir and keeps a bare field with the fallback direction", () => {
    expect(parseListSort("company_desc", allowed, "updated", "desc")).toEqual({ field: "company", dir: "desc" });
    expect(parseListSort("score_asc", allowed, "updated", "desc")).toEqual({ field: "score", dir: "asc" });
    expect(parseListSort("company", allowed, "updated", "desc")).toEqual({ field: "company", dir: "desc" });
  });

  it("falls back on missing or unknown sort", () => {
    expect(parseListSort(undefined, allowed, "updated", "desc")).toEqual({ field: "updated", dir: "desc" });
    expect(parseListSort("nope_desc", allowed, "updated", "desc")).toEqual({ field: "updated", dir: "desc" });
    expect(parseListSort("", allowed, "observed", "desc")).toEqual({ field: "observed", dir: "desc" });
  });
});
