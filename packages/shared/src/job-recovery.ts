const SCANS = new Set(["board_scan", "watch_check", "scan_url"]);

/** Explain failures without treating an upstream refusal as a closed posting. */
export function jobRecovery(type: string, error: string | null) {
  const e = error || "";
  if (/public HTTP|private|reserved address|invalid.*url|unsupported.*url/i.test(e)) {
    return { kind: "invalid_url", retryable: false, title: "URL needs attention", advice: "Check the source URL. Only public HTTP(S) job pages are supported." };
  }
  if (SCANS.has(type) && /\b(401|403|captcha|forbidden)\b|access denied/i.test(e)) {
    return { kind: "blocked", retryable: false, title: "Site blocked automated access", advice: "Open the listing in your browser. Use the Job clipper in Settings › System to save visible text, or update the source URL. This does not mean the job is closed." };
  }
  if (SCANS.has(type) && /\b(404|410)\b/.test(e)) {
    return { kind: "missing", retryable: false, title: "Page no longer available", advice: "Check the employer's current careers page and update or disable this source." };
  }
  if (SCANS.has(type) && /timeout|timed out|aborted|fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|\b(?:429|5\d\d)\b/i.test(e)) {
    return { kind: "temporary", retryable: true, title: "Temporary fetch failure", advice: "Retry this check. If it keeps failing, check the source URL and network connection." };
  }
  if (!SCANS.has(type) && type !== "retention") {
    return { kind: "model", retryable: false, title: "AI operation failed", advice: "Check the model, provider access and daily limits in Settings › AI, then use Retry failed there." };
  }
  return { kind: "unknown", retryable: false, title: "Check failed", advice: "Inspect the error and source before retrying. The existing position has been kept." };
}
