import { fetchJobFromUrl as atsFetch, type AtsJob } from "@job-scout/ats";
import { steelRenderer } from "./browser.js";

/** fetchJobFromUrl with the browser plane as JS fallback (Workday & friends). */
export function fetchJob(url: string): Promise<AtsJob> {
  return atsFetch(url, { render: steelRenderer });
}
