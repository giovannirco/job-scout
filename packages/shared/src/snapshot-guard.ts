import { canonicalCompanySlug } from "./company-alias.js";
import { canonicalExternalIdentity, normalizePostingUrl } from "./position-identity.js";

/** JD refresh is frozen from interview stage on: the JD you interviewed for is the record. */
export const JD_FROZEN_STATUSES = ["interview", "offer"] as const;

export function jdRefreshFrozen(status?: string | null): boolean {
  return (JD_FROZEN_STATUSES as readonly string[]).includes(String(status || ""));
}

/** Alias match for upsert dedupe: two unparseable URLs ("" === "") never match each other. */
export function sameNormalizedUrl(a?: string | null, b?: string | null): boolean {
  const x = normalizePostingUrl(a);
  return Boolean(x) && x === normalizePostingUrl(b);
}

function companyKey(name?: string | null): string {
  const raw = (name || "").trim();
  if (!raw || /^__unresolved__$/i.test(raw)) return "";
  return canonicalCompanySlug(raw).replace(/[^a-z0-9]/g, "");
}

/** Same employer? Unknown on either side is not evidence of a mismatch. */
export function companiesMatch(a?: string | null, b?: string | null): boolean {
  const x = companyKey(a);
  const y = companyKey(b);
  if (!x || !y) return true;
  return x === y || (x.length >= 4 && y.includes(x)) || (y.length >= 4 && x.includes(y));
}

function hostOf(url?: string | null): string {
  const n = normalizePostingUrl(url);
  if (!n) return "";
  try {
    return new URL(n).hostname;
  } catch {
    return "";
  }
}

/** Job ids that identify one posting across every tenant of the provider (not Workday-style "R1234" reqs). */
const GLOBAL_ID_PROVIDERS = new Set(["greenhouse", "lever", "ashby", "inhire"]);
function globallyUniqueJobId(provider: string, jobId: string): boolean {
  return GLOBAL_ID_PROVIDERS.has(provider) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(jobId);
}

export type SnapshotTarget = {
  companyName?: string | null;
  primaryUrl?: string | null;
  atsProvider?: string | null;
  atsJobId?: string | null;
  externalIdentity?: string | null;
};

export type SnapshotIncoming = {
  company?: string | null;
  url?: string | null;
  provider?: string | null;
  jobId?: string | null;
  externalIdentity?: string | null;
};

/**
 * A fetched posting may only be applied to a position when it is the same
 * posting: same company and the same ATS identity / URL. Returns the reason it
 * is NOT, or null when it is safe to apply.
 */
export function snapshotIdentityMismatch(pos: SnapshotTarget, job: SnapshotIncoming): string | null {
  // The canonical ATS identity is the strongest evidence: a matching one wins over
  // display-name drift ("Acme" vs "Acme Payments Ltd"), so it is checked first.
  const pi = canonicalExternalIdentity(pos.externalIdentity);
  const ji = canonicalExternalIdentity(job.externalIdentity);
  if (pi && ji && pi.toLowerCase() === ji.toLowerCase() && !/^(other|unknown):/i.test(pi)) return null;
  const sameProvider = Boolean(pos.atsProvider && job.provider && pos.atsProvider === job.provider && !["other", "unknown"].includes(pos.atsProvider!));
  if (sameProvider && pos.atsJobId && job.jobId && pos.atsJobId.toLowerCase() === job.jobId.toLowerCase() && globallyUniqueJobId(pos.atsProvider!, pos.atsJobId)) return null;
  if (!companiesMatch(pos.companyName, job.company)) return `company:${job.company}≠${pos.companyName}`;
  if (sameProvider && pos.atsJobId && job.jobId && pos.atsJobId.toLowerCase() !== job.jobId.toLowerCase()) {
    return `ats_job_id:${job.jobId}≠${pos.atsJobId}`;
  }
  if (pi && ji && pi.toLowerCase() !== ji.toLowerCase() && !/^(other|unknown):/.test(pi) && !/^(other|unknown):/.test(ji)) return `external_identity:${ji}≠${pi}`;
  const ph = hostOf(pos.primaryUrl);
  const jh = hostOf(job.url);
  if (ph && jh && ph !== jh && normalizePostingUrl(pos.primaryUrl) !== normalizePostingUrl(job.url)) return `url_host:${jh}≠${ph}`;
  return null;
}
