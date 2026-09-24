import { describe, expect, it } from "vitest";
import { RESULT_CAP, text } from "./result.js";

describe("MCP result limits", () => {
  it("preserves small JSON and explicit errors", () => {
    expect(JSON.parse(text({ items: [1] }).content[0].text)).toEqual({ items: [1] });
    expect(text({ error: "missing" }, true).isError).toBe(true);
  });
  it("returns a parseable error instead of slicing oversized JSON or Unicode", () => {
    for (const value of [{ description: "x".repeat(RESULT_CAP) }, { description: "🧭".repeat(30_000) }, "x".repeat(RESULT_CAP + 1)]) {
      const result = text(value);
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text).code).toBe("RESULT_TOO_LARGE");
      expect(Buffer.byteLength(result.content[0].text)).toBeLessThan(RESULT_CAP);
    }
  });
});
