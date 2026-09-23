/** With a model, Pipeline opens on scored PASS verdicts. Without one, those never exist, so show the filings. */
export function defaultPipelinePreset(llmConfigured: boolean): "decide" | "all" {
  return llmConfigured ? "decide" : "all";
}

/**
 * Sort when the URL does not name one. Score when a verdict is selected.
 * Open filings use the employer posted date. First seen is when this app stored the row.
 * Working and archived lists stay on recently updated.
 */
export const PIPELINE_SORT_OPTIONS: { value: string; label: string }[] = [
  { value: "updated_desc", label: "recently updated" },
  { value: "score_desc", label: "triage score" },
  { value: "first_seen_desc", label: "first seen, newest" },
  { value: "first_seen_asc", label: "first seen, oldest" },
  { value: "posted_desc", label: "posted, newest" },
  { value: "posted_asc", label: "posted, oldest" },
  { value: "last_changed_desc", label: "last changed" },
  { value: "last_changed_asc", label: "last changed, oldest" },
  { value: "company_asc", label: "company" },
  { value: "status_asc", label: "status" },
  { value: "title_asc", label: "title" },
  { value: "location_asc", label: "location" },
];

/** The column header can flip a sort. The menu must still name that direction. */
export function pipelineSortOptions(current?: string): { value: string; label: string }[] {
  const sort = current || "updated_desc";
  if (PIPELINE_SORT_OPTIONS.some((option) => option.value === sort)) return PIPELINE_SORT_OPTIONS;
  return [...PIPELINE_SORT_OPTIONS, { value: sort, label: sort.replace(/_/g, " ") }];
}

export function pipelineSortFallback(search: { verdict?: string; status?: string; sort?: string }): string {
  if (search.sort) return search.sort;
  if (search.verdict && search.verdict !== "none") return "score_desc";
  if (search.status === "hot" || search.status === "archived") return "updated_desc";
  return "posted_desc";
}
