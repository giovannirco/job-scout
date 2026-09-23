/** With a model, Pipeline opens on scored PASS verdicts. Without one, those never exist, so show the filings. */
export function defaultPipelinePreset(llmConfigured: boolean): "decide" | "all" {
  return llmConfigured ? "decide" : "all";
}

/**
 * Sort when the URL does not name one. Score when a verdict is selected.
 * Open filings use first seen, because updated_at also moves on our own repairs.
 * Working and archived lists stay on recently updated.
 */
export function pipelineSortFallback(search: { verdict?: string; status?: string; sort?: string }): string {
  if (search.sort) return search.sort;
  if (search.verdict && search.verdict !== "none") return "score_desc";
  if (search.status === "hot" || search.status === "archived") return "updated_desc";
  return "first_seen_desc";
}
