import { z } from "zod";
import type { ChatMessage } from "../client.js";

/**
 * Evaluate: the full A-H report (career-ops modes/pipeline.md) with the whole
 * profile + master resume. User-triggered; stronger model.
 */

export const EvaluateSummary = z.object({
  score: z.number().min(0).max(5),
  verdict: z.enum(["apply", "consider", "skip"]),
  headline: z.string().describe("One sentence recommendation"),
  strengths: z.array(z.string()),
  gaps: z.array(z.string()),
  questionsToAsk: z.array(z.string()),
  resumeAngle: z.string().describe("Which resume surface/angle to lead with"),
});
export type EvaluateSummary = z.infer<typeof EvaluateSummary>;

/** The document is free markdown; the trailing JSON block is the summary. */
export const EvaluateOutput = EvaluateSummary;
export type EvaluateOutput = EvaluateSummary;

export type EvaluateInput = {
  title: string;
  company: string;
  companyOverview?: string | null;
  url?: string | null;
  locationRaw?: string | null;
  salaryRaw?: string | null;
  jdText: string;
  identityMarkdown: string;
  masterResumeMarkdown: string;
  brief: string;
  triageJson?: Record<string, unknown> | null;
};

export function buildEvaluateMessages(i: EvaluateInput): ChatMessage[] {
  const system = [
    "You are a senior career strategist evaluating ONE job listing for ONE candidate.",
    "Write a rigorous, honest report. Do not flatter. Quote the JD when you claim a requirement.",
    "",
    "Report structure (markdown, use these exact H2 headings):",
    "## A. Role snapshot — what the job really is, level, team, why it exists",
    "## B. Must-haves vs evidence — table: requirement | evidence from resume | strength (strong/partial/none)",
    "## C. Gaps and how to bridge — each gap with a one-line bridge or 'cannot bridge'",
    "## D. Compensation and location — advertised comp vs floor/ask; remote/geo eligibility from Brazil",
    "## E. Company signal — stage, product, why platform/SRE matters to them, risks",
    "## F. Resume angle — which archetype to lead with, 3 bullets to surface, 2 to cut",
    "## G. Questions to ask — 5 sharp questions for a recruiter/hiring manager",
    "## H. Verdict — apply / consider / skip with a 0-5 score and one paragraph",
    "",
    "Write the full report first, then the JSON summary block described below.",
  ].join("\n");

  const user = [
    "## Candidate brief",
    i.brief.trim(),
    "",
    "## Candidate identity",
    i.identityMarkdown.trim() || "(none)",
    "",
    "## Master resume",
    i.masterResumeMarkdown.trim().slice(0, 24_000) || "(none)",
    "",
    "## Listing",
    `Title: ${i.title}`,
    `Company: ${i.company}`,
    i.companyOverview ? `Company overview: ${i.companyOverview.slice(0, 1500)}` : "",
    i.url ? `URL: ${i.url}` : "",
    `Location: ${i.locationRaw || "not stated"}`,
    `Compensation: ${i.salaryRaw || "not stated"}`,
    i.triageJson ? `Prior triage: ${JSON.stringify(i.triageJson).slice(0, 1200)}` : "",
    "",
    "## Job description",
    (i.jdText || "").slice(0, 16_000) || "(no description available)",
  ]
    .filter((l) => l !== "")
    .join("\n");

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}
