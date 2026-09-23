import { z } from "zod";
import type { ChatMessage } from "../client.js";

/** Resume and cover come back as `=== SECTION: resume ===` / `=== SECTION: cover ===`; this is the JSON tail. */
export const MaterialsOutput = z.object({
  resumeSurface: z.string().describe("Which surface was used (e.g. sre|platform|ai)"),
  keywordsCovered: z.array(z.string()),
  keywordsMissing: z.array(z.string()),
  notes: z.string().describe("What was emphasized/cut and why, 2-4 sentences"),
});
export type MaterialsOutput = z.infer<typeof MaterialsOutput>;

export type MaterialsInput = {
  title: string;
  company: string;
  jdText: string;
  identityMarkdown: string;
  masterResumeMarkdown: string;
  masterCoverMarkdown?: string | null;
  resumeSurfaces: Record<string, string>;
  preferredSurface?: string | null;
  evaluationMarkdown?: string | null;
  atsKeywords?: string[];
};

export function buildMaterialsMessages(i: MaterialsInput): ChatMessage[] {
  const surfaces = Object.entries(i.resumeSurfaces || {});
  const system = [
    "You tailor application materials for ONE candidate to ONE job.",
    "Hard rules:",
    "- Never invent employers, dates, titles, metrics or tools. Only reorder, select and rephrase what the master resume contains.",
    "- State positive contributions directly. Never-fabricate notes and authorship limits are instructions to you: never copy them into a resume or cover letter as self-descriptions, hedges, or statements of what the candidate is not. Shared delivery and code review do not diminish the candidate's contribution.",
    "- Mirror the JD's vocabulary where the candidate genuinely has the experience.",
    "- Resume: markdown, 1-2 pages, summary + skills + experience + selected projects. Lead with the archetype the JD buys.",
    "- Cover letter: <= 350 words, specific to the company and role, no clichés, no 'I am excited', no 'passionate'.",
    "Output the resume section, then the cover section, then the JSON block described below.",
  ].join("\n");

  const user = [
    "## Candidate identity",
    i.identityMarkdown.trim() || "(none)",
    "",
    "## Master resume",
    i.masterResumeMarkdown.trim().slice(0, 24_000) || "(none)",
    i.masterCoverMarkdown ? `\n## Master cover template\n${i.masterCoverMarkdown.trim().slice(0, 3000)}` : "",
    surfaces.length
      ? `\n## Resume surfaces (angles)\n${surfaces.map(([k, v]) => `- ${k}: ${v.slice(0, 400)}`).join("\n")}`
      : "",
    i.preferredSurface ? `Preferred surface: ${i.preferredSurface}` : "",
    i.evaluationMarkdown ? `\n## Prior evaluation (use section F)\n${i.evaluationMarkdown.slice(0, 5000)}` : "",
    i.atsKeywords?.length ? `\n## ATS keywords to cover when true\n${i.atsKeywords.join(", ")}` : "",
    "",
    "## Target listing",
    `Title: ${i.title}`,
    `Company: ${i.company}`,
    "",
    "## Job description",
    (i.jdText || "").slice(0, 14_000) || "(no description available)",
  ]
    .filter((l) => l !== "")
    .join("\n");

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}
