/** What to tell the operator after they promote a discovery row into the pipeline. */
export function promoteMessage(meta: { created?: unknown; revived?: unknown; triageJobId?: unknown }): string {
  if (meta.created) return meta.triageJobId ? "Promoted — triage queued" : "Promoted";
  if (meta.revived) return "Revived — back in the pipeline";
  return "Already in the pipeline";
}

/** What to tell the operator after they ask for a discovery pass. */
export function discoveryQueuedMessage(result: { enqueued: number }): string {
  if (result.enqueued <= 0) return "No boards are due. Discovery already ran recently.";
  const n = result.enqueued;
  return `Discovery queued for ${n} ${n === 1 ? "board" : "boards"}`;
}
