import { describe, expect, it } from "vitest";
import { greenhouseQuestionPrompts, parseApplicationQuestions } from "./application-form.js";

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

  it("keeps Greenhouse required flags, file fields, and select labels", () => {
    const parsed = greenhouseQuestionPrompts([
      { label: "First Name", required: true, fields: [{ type: "input_text" }] },
      { label: "Address Line 2 (Optional)", required: false, fields: [{ type: "input_text" }] },
      { label: "Resume/CV", required: true, fields: [{ type: "input_file" }, { type: "textarea" }] },
      {
        label: "Will you require sponsorship?",
        required: true,
        fields: [{ type: "multi_value_single_select", values: [{ label: "Yes" }, { label: "No" }] }],
      },
    ]);
    expect(parsed).toEqual([
      { question: "First Name", required: true, inputType: "text" },
      { question: "Address Line 2 (Optional)", required: false, inputType: "text" },
      { question: "Resume/CV", required: true, inputType: "file" },
      { question: "Will you require sponsorship?", required: true, inputType: "select", options: ["Yes", "No"] },
    ]);
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
