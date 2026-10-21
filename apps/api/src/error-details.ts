/**
 * Structured fields carried by core errors (AtsFetchError, BoardIndexError) so
 * MCP and REST callers see *why* a fetch or intake failed, never a bare message.
 */
export function errorDetails(e: unknown): Record<string, unknown> {
  if (!e || typeof e !== "object") return {};
  const out: Record<string, unknown> = {};
  for (const key of ["reason", "httpStatus", "causeCode", "provider", "url", "suggestion", "boardSuggestion"] as const) {
    const value = (e as Record<string, unknown>)[key];
    if (value != null && value !== "") out[key] = value;
  }
  return out;
}
