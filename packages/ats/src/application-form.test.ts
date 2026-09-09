import { describe, expect, it } from "vitest";
import { parseApplicationQuestions } from "./application-form.js";

describe("parseApplicationQuestions", () => {
  it("reads required labels from Ashby-like HTML", () => {
    const parsed = parseApplicationQuestions(
      `<form><label>Name*</label><label>Email*</label><label>What is your experience with bitcoin and lightning?*</label></form>`,
    );
    expect(parsed.map((p) => p.question)).toEqual([
      "Name",
      "Email",
      "What is your experience with bitcoin and lightning?",
    ]);
    expect(parsed.every((p) => p.required)).toBe(true);
  });

  it("falls back to starred lines when there are no label tags", () => {
    const parsed = parseApplicationQuestions(
      `<div>Name*</div><div>Email*</div><div>What is your experience with bitcoin and lightning?*</div>`,
    );
    expect(parsed.map((p) => p.question)).toEqual([
      "Name",
      "Email",
      "What is your experience with bitcoin and lightning?",
    ]);
  });
});
