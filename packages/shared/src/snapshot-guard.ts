import { canonicalCompanySlug } from "./company-alias.js";
import { canonicalExternalIdentity, normalizePostingUrl } from "./position-identity.js";

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
  if (!companiesMatch(pos.companyName, job.company)) return `company:${job.company}≠${pos.companyName}`;
  const pi = canonicalExternalIdentity(pos.externalIdentity);
  const ji = canonicalExternalIdentity(job.externalIdentity);
  if (pi && ji && pi === ji) return null;
  if (pos.atsProvider && job.provider && pos.atsProvider === job.provider && pos.atsJobId && job.jobId && pos.atsJobId !== job.jobId) {
    return `ats_job_id:${job.jobId}≠${pos.atsJobId}`;
  }
  if (pi && ji && pi !== ji && !/^(other|unknown):/.test(pi) && !/^(other|unknown):/.test(ji)) return `external_identity:${ji}≠${pi}`;
  const ph = hostOf(pos.primaryUrl);
  const jh = hostOf(job.url);
  if (ph && jh && ph !== jh && normalizePostingUrl(pos.primaryUrl) !== normalizePostingUrl(job.url)) return `url_host:${jh}≠${ph}`;
  return null;
}
