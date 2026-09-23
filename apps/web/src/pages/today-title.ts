/** Today counts PASS verdicts, approvals, and interviews. Unscored filings are a reading list, not "nothing". */
export function todayTitle(input: { needs: number; untriaged: number; llmConfigured: boolean }): string {
  if (input.needs > 0) return `${input.needs} ${input.needs === 1 ? "thing needs" : "things need"} you`;
  if (!input.llmConfigured && input.untriaged > 0) {
    return `${input.untriaged} ${input.untriaged === 1 ? "filing" : "filings"}, none scored`;
  }
  return "Nothing needs you right now";
}

/** The stage is named Triaged, and "untriaged" means no verdict. When they are the same pile, say so once. */
export function unscoredStage(triaged: number, untriaged: number): boolean {
  return triaged > 0 && untriaged === triaged;
}
