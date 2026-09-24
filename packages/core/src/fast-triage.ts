import type { TriageOutput } from "@job-scout/llm";
import type { DecisionRecord } from "@job-scout/shared";

export function fastTriageOutput(run: DecisionRecord | null, input: { salaryRaw: string | null; jdText: string; passThreshold: number }): TriageOutput | null {
  if (!run?.summary?.accepted || !run.result || run.summary.score == null || run.summary.score < input.passThreshold) return null;
  // Pay comparisons need the normal salary parser and triage path.
  if (input.salaryRaw || /[$€£¥]|\b(?:USD|EUR|GBP|BRL|salary|compensation|pay|remuneration|sal[aá]rio)\b/i.test(input.jdText)) return null;
  const a = run.result.answers;
  if (a.role.type !== "score" || a.skills.type !== "score" || a.seniority.type !== "score" || a.role.score < 3 || a.skills.score < 3 || a.seniority.score < 3) return null;
  const score = run.summary.score;
  return {
    score, archetype: a.role.score / 4 * 5, cvMatch: a.skills.score / 4 * 5,
    comp: 4, location: 5, hardDq: [], softFlags: ["Compensation is not stated; confirm it before applying."],
    archetypeLabel: "Jev role match", compNote: "not stated", locationNote: "Jev found explicit eligibility evidence; confirm before applying.",
    oneLiner: `Jev shortlist: role ${(a.role.score / 4 * 5).toFixed(1)}/5, skills ${(a.skills.score / 4 * 5).toFixed(1)}/5. Compensation needs confirmation.`,
  };
}
