/** What to tell the operator after they ask for a discovery pass. */
export function discoveryQueuedMessage(result: { enqueued: number }): string {
  if (result.enqueued <= 0) return "No boards are due. Discovery already ran recently.";
  const n = result.enqueued;
  return `Discovery queued for ${n} ${n === 1 ? "board" : "boards"}`;
}
