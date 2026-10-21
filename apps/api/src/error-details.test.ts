import { describe, expect, it } from "vitest";
import { AtsFetchError } from "@job-scout/ats";
import { BoardIndexError } from "@job-scout/core";
import { errorDetails } from "./error-details.js";

describe("errorDetails", () => {
  it("carries an ATS fetch failure's reason and status", () => {
    const e = new AtsFetchError({ reason: "blocked", httpStatus: 403, message: "ats fetch returned HTTP 403", url: "https://careers.acme-example.com/jobs/1" });
    expect(errorDetails(e)).toEqual({ reason: "blocked", httpStatus: 403, url: "https://careers.acme-example.com/jobs/1" });
  });

  it("carries a board-index refusal's suggestion", () => {
    const e = new BoardIndexError({ reason: "board_url", index: { provider: "greenhouse", boardToken: "acme-example", scannable: true } });
    expect(errorDetails(e)).toMatchObject({ reason: "board_url", boardSuggestion: { provider: "greenhouse", token: "acme-example" } });
    expect(String(errorDetails(e).suggestion)).toMatch(/board source/);
  });

  it("returns nothing for a plain error", () => {
    expect(errorDetails(new Error("boom"))).toEqual({});
  });
});
