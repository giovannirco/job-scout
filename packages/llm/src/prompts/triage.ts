import { z } from "zod";
import type { ChatMessage } from "../client.js";

/**
 * Triage: cheap model, one listing in, one 1-5 score out.
 * Ported from career-ops modes/triage.md + modes/_brief.md.
 */

export const TriageOutput = z.object({
  score: z.number().min(0).max(5).describe("Overall fit 0-5, one decimal"),
  archetype: z.number().min(0).max(5).describe("Archetype fit 0-5"),
  comp: z.number().min(0).max(5).describe("Compensation fit 0-5; 5 when unknown but plausible"),
  location: z.number().min(0).max(5).describe("Location/remote fit 0-5"),
  cvMatch: z.number().min(0).max(5).describe("Resume evidence vs must-haves 0-5"),
  hardDq: z.array(z.string()).describe("Hard disqualifiers found; empty when none"),
  softFlags: z.array(z.string()).describe("Soft red flags found; empty when none"),
  archetypeLabel: z.string().describe("Closest archetype name or 'none'"),
  compNote: z.string().describe("Advertised comp summary or 'not stated'"),
  locationNote: z.string().describe("One phrase on remote/geo eligibility"),
  oneLiner: z.string().describe("<= 160 chars, why this verdict"),
});
export type TriageOutput = z.infer<typeof TriageOutput>;

export type TriageInput = {
  title: string;
  company: string;
  locationRaw?: string | null;
  workplaceType?: string | null;
  salaryRaw?: string | null;
  employmentType?: string | null;
  jdText: string;
  brief: string;
  jdMaxChars: number;
  passThreshold: number;
  marginalThreshold: number;
};

export function buildTriageMessages(input: TriageInput): ChatMessage[] {
  const jd = trimJd(input.jdText, input.jdMaxChars);
  const system = [
    "You are a strict job-fit triage engine for one specific candidate.",
    "Score a single job listing against the candidate brief. Be decisive; most listings are not a fit.",
    "",
    "Scoring rules:",
    "- archetype: direct hit on a target archetype 4-5; analog title 3; mismatch 1-2.",
    "- comp: below the hard floor => 0-1 and add a hardDq. For an advertised range, apply the floor to the range maximum (wide ranges are geo bands); a minimum below the floor is a soft flag, not a hardDq. Not stated => 4 unless the role/level implies low pay.",
    "- location: use the brief's location scoring table. On-site with no remote path => 1 and hardDq.",
    "- eligibility: if the listing restricts who may apply and the candidate is outside that group (affirmative postings for a specific group, citizenship or security-clearance requirements, employment limited to countries the candidate cannot work from with no contractor path) => hardDq.",
    "- cvMatch: how many must-haves the proof points cover. Missing a required stack the candidate does not claim => hardDq.",
    "- score = weighted overall: archetype 35%, location 25%, cvMatch 25%, comp 15%, then subtract 0.5 per soft flag.",
    `- Any hardDq forces score < ${input.marginalThreshold.toFixed(1)}.`,
    `- Bands: >= ${input.passThreshold.toFixed(1)} PASS, ${input.marginalThreshold.toFixed(1)}-${(input.passThreshold - 0.1).toFixed(1)} MARGINAL, below FAIL.`,
    "Respond with a single JSON object matching the schema. No prose.",
  ].join("\n");

  const user = [
    "## Candidate brief",
    input.brief.trim(),
    "",
    "## Listing",
    `Title: ${input.title}`,
    `Company: ${input.company}`,
    `Location: ${input.locationRaw || "not stated"}`,
    input.workplaceType ? `Workplace: ${input.workplaceType}` : "",
    `Compensation: ${input.salaryRaw || "not stated"}`,
    input.employmentType ? `Employment type: ${input.employmentType}` : "",
    "",
    "## Job description",
    jd || "(no description available — score on title, location and comp only; lower cvMatch to 3)",
  ]
    .filter((l) => l !== "")
    .join("\n");

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

export function trimJd(text: string, maxChars: number): string {
  const t = (text || "").replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
  if (t.length <= maxChars) return t;
  // Keep the head (role + requirements usually) and a tail slice (comp/benefits often at end)
  const head = Math.floor(maxChars * 0.8);
  const tail = maxChars - head;
  return `${t.slice(0, head)}\n[...]\n${t.slice(-tail)}`;
}

export function verdictFor(
  score: number,
  hardDq: string[],
  thresholds: { passThreshold: number; marginalThreshold: number },
): "pass" | "marginal" | "fail" {
  if (hardDq.length) return "fail";
  if (score >= thresholds.passThreshold) return "pass";
  if (score >= thresholds.marginalThreshold) return "marginal";
  return "fail";
}
