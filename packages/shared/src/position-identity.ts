import { canonicalCompanySlug } from "./company-alias.js";

export const UNRESOLVED_COMPANY = "__unresolved__";
export const KNOWN_AGGREGATORS = new Set([
  "weworkremotely", "we-work-remotely", "jobicy", "remotive", "getonbrd", "arbeitnow", "jobgether", "remoteok", "remote-ok",
]);

export function unresolvedCompany(name?: string | null): boolean {
  const key = canonicalCompanySlug(name || "");
  return !key || /^(clipped|unknown|unresolved)$/.test(key) || KNOWN_AGGREGATORS.has(key);
}

/** Normalize transport/tracking differences, preserving query parameters that identify a job. */
export function normalizePostingUrl(value?: string | null): string {
  try {
    const u = new URL(value || "");
    if (!/^https?:$/.test(u.protocol)) return "";
    u.hash = "";
    u.protocol = "https:";
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, "");
    if (u.hostname === "boards.greenhouse.io") u.hostname = "job-boards.greenhouse.io";
    if (/greenhouse\.io$/.test(u.hostname)) {
      u.pathname = u.pathname.replace(/^\/(gympass|wellhub)\//i, "/wellhub/");
    }
    for (const key of [...u.searchParams.keys()]) {
      if (/^(utm_.+|gh_src|source|ref|referrer|fbclid|gclid|lever-source|lever-origin)$/i.test(key)) u.searchParams.delete(key);
    }
    u.searchParams.sort();
    u.pathname = u.pathname.replace(/\/+$/, "");
    return u.toString().replace(/\/$/, "");
  } catch { return ""; }
}

/** A single opening, not a company's careers root. */
export function isJobPostingUrl(value?: string | null): boolean {
  try {
    const u = new URL(value || "");
    if (u.searchParams.has("gh_jid")) return true;
    if (/\/jobs\/\d+(?:\/|$)/.test(u.pathname)) return true;
    if (/^jobs\.ashbyhq\.com$/i.test(u.hostname) && /\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/?$/i.test(u.pathname)) return true;
    return false;
  } catch {
    return false;
  }
}

export function canonicalExternalIdentity(value?: string | null): string | null {
  if (!value) return null;
  const parts = value.split(":");
  if (parts.length === 3 && ["greenhouse", "ashby", "lever"].includes(parts[0])) parts[1] = canonicalCompanySlug(parts[1]);
  return parts.join(":");
}

const TRAILING_PLACE = String.raw`republic of ireland|united kingdom|united states|the netherlands|new zealand|south africa|czech republic|australia|singapore|germany|ireland|sweden|spain|poland|france|portugal|greece|norway|israel|switzerland|romania|hungary|japan|india|brazil|brasil|chile|mexico|argentina|colombia|turkiye|turkey|canada|netherlands|uk|usa|us|remote`;

/** Seniority is meaningful: Canonical's Senior and non-Senior roles must remain distinct. */
export function decisionTitle(title: string): string {
  let text = title.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/\b(sr\.?)(?=\s)/g, "senior");
  const trailing = new RegExp(String.raw`\s*[-|,(]\s*(?:${TRAILING_PLACE})(?:\s+remote)?\)?\s*$`, "i");
  for (let i = 0; i < 4; i++) {
    const next = text.replace(trailing, "");
    if (next === text) break;
    text = next;
  }
  return text.replace(/[^a-z0-9]+/g, " ").trim();
}

/** ATS posting IDs are not requisition IDs. Only explicit identifiers in the JD count. */
export function requisitionId(text = ""): string | null {
  return text.match(/\b(?:requisition|req)(?:uisition)?\s*(?:id|number|no\.?)?\s*[:#-]?\s*([a-z]*\d[a-z\d-]*)\b/i)?.[1]?.toUpperCase() || null;
}

export function cleanLocation(value?: string | null): string {
  return (value || "").split(/\s*[·•;|]\s*/).map(p => p.replace(/\[object Object\]/g, "").trim()).filter(Boolean).join(" · ");
}

/** The employer on the posting, unless that name is the job board itself. */
export function listingCompany(jobCompany: string | null | undefined, boardCompany: string): string {
  const job = (jobCompany || "").trim();
  if (job && !unresolvedCompany(job)) return job;
  return boardCompany;
}

/** Recover only where the host's slug format and the exact title make the boundary deterministic. */
export function employerFromPosting(url: string, title: string): string | null {
  try {
    const u = new URL(url);
    if (!/(^|\.)weworkremotely\.com$/.test(u.hostname)) return null;
    const slug = decodeURIComponent(u.pathname.split("/").filter(Boolean).at(-1) || "");
    const role = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const index = slug.toLowerCase().lastIndexOf(`-${role}`);
    if (index < 1 || !/^(-\d+)?$/.test(slug.slice(index + role.length + 1))) return null;
    return slug.slice(0, index).split("-").map(s => s.charAt(0).toUpperCase() + s.slice(1)).join(" ");
  } catch { return null; }
}
