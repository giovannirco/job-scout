/**
 * Structured fields carried by core errors (AtsFetchError, BoardIndexError) so
 * MCP and REST callers see *why* a fetch or intake failed, never a bare message.
 * A board-index refusal also carries `code: "board_index"`.
 */
export function errorDetails(e: unknown): Record<string, unknown> {
  if (!e || typeof e !== "object") return {};
  const out: Record<string, unknown> = {};
  // Only the intake refusal's code is passed through, never arbitrary ones such as ECONNREFUSED.
  if ((e as { code?: unknown }).code === "board_index") out.code = "board_index";
  for (const key of ["reason", "httpStatus", "causeCode", "provider", "url", "suggestion", "boardSuggestion"] as const) {
    const value = (e as Record<string, unknown>)[key];
    if (value != null && value !== "") out[key] = value;
  }
  return out;
}
