/** Words a person typed, ignoring dashes and other punctuation between them. */
export function searchWords(query: string): string[] {
  const words = query
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .map((word) => word.trim())
    .filter((word) => word.length >= 2);
  return [...new Set(words)];
}

/** ILIKE pattern. `%` and `_` in the typed text stay literal. */
export function likeContains(token: string): string {
  return `%${token.replace(/[\\%_]/g, "\\$&")}%`;
}
