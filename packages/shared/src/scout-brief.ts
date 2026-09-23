/** The seeded brief is instructions, not a person's background. */
export function isStarterScoutBrief(text: string | null | undefined): boolean {
  const body = (text || "").replace(/\s+/g, " ").trim();
  if (!body) return false;
  return /fill this in under settings/i.test(body);
}
