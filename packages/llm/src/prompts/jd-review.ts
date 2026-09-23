import { z } from "zod";
import type { ChatMessage } from "../client.js";

/** JD vs resume gap analysis — quicker and narrower than evaluate. */
export const JdReviewOutput = z.object({
    score: z.number().min(0).max(5),
    matches: z.array(z.string()),
    gaps: z.array(z.string()),
    keywordsToAdd: z.array(z.string()),
    seniorityRead: z.string(),
});
export type JdReviewOutput = z.infer<typeof JdReviewOutput>;

export type JdReviewInput = {
  title: string;
  company: string;
  jdText: string;
  masterResumeMarkdown: string;
  atsKeywords?: string[];
};

export function buildJdReviewMessages(i: JdReviewInput): ChatMessage[] {
  const system = [
    "You compare a job description against a candidate's master resume.",
    "Output a markdown review with H2 sections: Requirements coverage (table), Gaps, Keywords to add, Seniority read, Score.",
    "Score 0-5 on how well the resume as-is would pass a recruiter screen for this JD.",
    "Write the review as markdown first, then the JSON summary block described below.",
  ].join("\n");
  const user = [
    `Title: ${i.title}`,
    `Company: ${i.company}`,
    i.atsKeywords?.length ? `ATS keyword catalog hits: ${i.atsKeywords.join(", ")}` : "",
    "",
    "## Job description",
    (i.jdText || "").slice(0, 14_000),
    "",
    "## Master resume",
    i.masterResumeMarkdown.slice(0, 24_000),
  ]
    .filter((l) => l !== "")
    .join("\n");
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}
