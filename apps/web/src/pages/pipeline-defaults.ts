/** With a model, Pipeline opens on scored PASS verdicts. Without one, those never exist, so show the filings. */
export function defaultPipelinePreset(llmConfigured: boolean): "decide" | "all" {
  return llmConfigured ? "decide" : "all";
}
