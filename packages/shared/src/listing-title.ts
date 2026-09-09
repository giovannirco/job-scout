/**
 * Detect ATS/HTML scrape garbage that must never replace a real role title.
 * Examples: "Closed role", "Current openings at Strike", bare "Jobs".
 */
export function isShellJobTitle(title?: string | null): boolean {
  const t = (title || "").trim();
  if (!t) return true;
  if (t.length < 3) return true;
  if (/^closed(\s+role)?$/i.test(t)) return true;
  if (/^closed\s+or\s+missing$/i.test(t)) return true;
  if (/^unknown(\s+role)?$/i.test(t)) return true;
  if (/^(jobs?|careers?|openings?|opportunities)$/i.test(t)) return true;
  if (/^current\s+openings?\b/i.test(t)) return true;
  if (/\bopenings?\s+at\b/i.test(t)) return true;
  if (/\b(jobs?|careers?)\s+at\b/i.test(t)) return true;
  if (/^all\s+(open\s+)?(jobs?|roles?|positions?)\b/i.test(t)) return true;
  if (/^we['']?re\s+hiring\b/i.test(t)) return true;
  if (/^join\s+(our|the)\s+team\b/i.test(t)) return true;
  if (/^job\s+board\b/i.test(t)) return true;
  if (/^search\s+jobs?\b/i.test(t)) return true;
  return false;
}

const ROLE_TOKEN =
  /(engineer|sre|devops|platform|reliability|infra|software|senior|staff|principal|manager|architect|security|kubernetes|data|mlops|site|backend|frontend|fullstack|cloud|observability|systems?)/i;

/**
 * Empty/shell titles plus promote-noise tokens (e.g. "2byg") that are not real roles.
 * Safe for bulk archive of research/idea only — never hot CRM stages.
 */
export function isNoiseJobTitle(title?: string | null): boolean {
  if (isShellJobTitle(title)) return true;
  const t = (title || "").trim();
  if (!t) return true;
  // short single-token garbage (hash/id mistaken as title)
  if (t.length <= 8 && !/\s/.test(t) && !ROLE_TOKEN.test(t) && /^[a-z0-9_-]+$/i.test(t)) {
    return true;
  }
  return false;
}

/** Seed / fake ATS links that never yield a real single-job page. */
export function isPlaceholderAtsUrl(url?: string | null): boolean {
  if (!url) return true;
  const u = url.trim();
  if (!u) return true;
  try {
    const parsed = new URL(u);
    if (!/^https?:$/.test(parsed.protocol)) return true;
    if (/(^|\.)example\.(com|org|net)$/i.test(parsed.hostname)) return true;
    if (/(?:^|\/)(?:critic-unparsed-[^/]*|[^/]*(?:-demo|-fixture))(?:\/|$)/i.test(parsed.pathname)) return true;
  } catch { return true; }
  if (/\/jobs?\/example\b/i.test(u)) return true;
  if (/\/example(\/|$|\?)/i.test(u)) return true;
  if (/0{4}-0{4}-0{4}-0{12}/i.test(u)) return true;
  if (/00000000000/i.test(u)) return true;
  // Ashby zero-padded fake UUIDs (…-0000-0000-0000-…)
  if (/[0-9a-f]{8}-0{4}-0{4}-0{4}-[0-9a-f]{12}/i.test(u)) return true;
  // Greenhouse board token is a generic path segment (mis-imported)
  if (/greenhouse\.io\/(careers|boards|jobs|job-boards)\//i.test(u)) return true;
  return false;
}

/** Humanize slug when we must recover a title (e.g. after Closed role clobber). */
export function titleFromSlug(slug?: string | null, companySlug?: string | null): string | null {
  if (!slug) return null;
  let s = slug.trim();
  if (!s) return null;
  if (companySlug) {
    const prefix = `${companySlug}-`;
    if (s.toLowerCase().startsWith(prefix.toLowerCase())) {
      s = s.slice(prefix.length);
    }
  }
  // strip trailing location tokens often appended in vault slugs
  const words = s
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => {
      if (/^(ai|sre|aws|gcp|oci|ml|ta)$/i.test(w)) return w.toUpperCase();
      if (w.length <= 2) return w.toLowerCase();
      return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    });
  if (!words.length) return null;
  return words.join(" ");
}

/** Prefer a real title over scrape/closed placeholders. */
export function preferJobTitle(
  incoming?: string | null,
  existing?: string | null,
  opts?: { slug?: string | null; companySlug?: string | null },
): string {
  const inc = (incoming || "").trim();
  const ex = (existing || "").trim();
  if (inc && !isShellJobTitle(inc)) return inc;
  if (ex && !isShellJobTitle(ex)) return ex;
  const fromSlug = titleFromSlug(opts?.slug, opts?.companySlug);
  if (fromSlug && !isShellJobTitle(fromSlug)) return fromSlug;
  return ex || inc || "Unknown role";
}
