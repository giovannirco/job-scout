export const RESULT_CAP = 100_000;

/** Never return partial JSON as a successful tool result. */
export function text(data: unknown, isError = false) {
  const compact = typeof data === "string" ? data : JSON.stringify(data);
  const pretty = typeof data === "string" || Buffer.byteLength(compact) > 30_000 ? compact : JSON.stringify(data, null, 2);
  if (Buffer.byteLength(pretty) > RESULT_CAP) {
    return {
      content: [{ type: "text" as const, text: JSON.stringify({
        error: "Result exceeds the response size limit. Request fewer rows, use narrower filters, or omit job description text where supported.",
        code: "RESULT_TOO_LARGE", limitBytes: RESULT_CAP,
      }) }],
      isError: true,
    };
  }
  return { content: [{ type: "text" as const, text: pretty }], isError };
}
