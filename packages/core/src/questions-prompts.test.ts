import { describe, expect, it } from "vitest";
import { promptsFromJob } from "./questions.js";

describe("promptsFromJob", () => {
  it("uses structured Greenhouse prompts instead of dropping required and choices", () => {
    const prompts = promptsFromJob({
      provider: "greenhouse",
      title: "Software Engineer",
      url: "https://example.test/job",
      listingStatus: "open",
      questions: ["First Name", "Resume/CV"],
      questionPrompts: [
        { question: "First Name*", required: true, inputType: "text" },
        { question: "Will you require sponsorship?", required: true, inputType: "select", options: ["Yes", "No"] },
      ],
    });
    expect(prompts).toEqual([
      { question: "First Name", required: true, inputType: "text" },
      { question: "Will you require sponsorship?", required: true, inputType: "select", options: ["Yes", "No"] },
    ]);
  });

  it("still reads a starred string when the ATS only sent text", () => {
    const prompts = promptsFromJob({
      provider: "ashby",
      title: "Software Engineer",
      url: "https://example.test/job",
      listingStatus: "open",
      questions: ["Name*", "Portfolio"],
    });
    expect(prompts.map((p) => [p.question, p.required])).toEqual([
      ["Name", true],
      ["Portfolio", false],
    ]);
  });
});
