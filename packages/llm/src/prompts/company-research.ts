import { z } from "zod";
import type { ChatMessage } from "../client.js";

export const CompanyResearchOutput = z.object({
    oneLiner: z.string(),
    stage: z.string().describe("e.g. seed, series B, public, bootstrapped, unknown"),
    headcountBand: z.string().describe("e.g. 11-50, 51-200, 1000+, unknown"),
    remotePolicy: z.string(),
    platformMaturity: z.string().describe("How much they need platform/SRE work, one phrase"),
    risks: z.array(z.string()),
    talkingPoints: z.array(z.string()),
});
export type CompanyResearchOutput = z.infer<typeof CompanyResearchOutput>;

export type CompanyResearchInput = {
  company: string;
  website?: string | null;
  careersUrl?: string | null;
  knownOverview?: string | null;
  openTitles: string[];
  sampleJd?: string | null;
};

export function buildCompanyResearchMessages(i: CompanyResearchInput): ChatMessage[] {
  const system = [
    "You write a compact company research pack for a platform/SRE job seeker.",
    "You do not have web access: reason only from the provided material plus general knowledge, and mark anything uncertain as such.",
    "Headings (H2): Overview, Product & customers, Stage & funding, Engineering & platform signals, Remote & hiring from Brazil, Risks, Talking points.",
    "Keep it under 600 words. Write the pack as markdown first, then the JSON summary block described below.",
  ].join("\n");
  const user = [
    `Company: ${i.company}`,
    i.website ? `Website: ${i.website}` : "",
    i.careersUrl ? `Careers: ${i.careersUrl}` : "",
    i.knownOverview ? `Known overview: ${i.knownOverview.slice(0, 2000)}` : "",
    i.openTitles.length ? `Open platform-ish roles seen: ${i.openTitles.slice(0, 15).join("; ")}` : "",
    i.sampleJd ? `\nSample JD:\n${i.sampleJd.slice(0, 6000)}` : "",
  ]
    .filter((l) => l !== "")
    .join("\n");
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}
