import { unresolvedCompany } from "./position-identity.js";

/**
 * Job aggregators repost other employers' openings. The page's company is often the
 * aggregator itself or hidden ("a partner company"), so a repost can look like a new role.
 * Keep this list small and generic: hosts whose postings are always reposts.
 */
export const AGGREGATOR_HOSTS = [
  "jobgether.com",
  "weworkremotely.com",
  "remotive.com",
  "jobicy.com",
  "remoteok.com",
  "getonbrd.com",
  "arbeitnow.com",
] as const;

/** The aggregator host behind a posting URL, or null for a direct employer/ATS posting. */
export function aggregatorHost(url?: string | null): string | null {
  try {
    const host = new URL(url || "").hostname.toLowerCase().replace(/^www\./, "");
    return AGGREGATOR_HOSTS.find((h) => host === h || host.endsWith(`.${h}`)) ?? null;
  } catch {
    return null;
  }
}

const GENERIC_EMPLOYER =
  /^(?:a|an|the|our|this|one of|confidential|undisclosed|stealth|anonymous|private|partner|client|employer|company|hiring company|recruiter|staffing)\b|\b(?:partner company|our client|a client|confidential|undisclosed)\b/i;

/** A plausible employer name, trimmed; null when it is generic, an aggregator or junk. */
export function cleanEmployerCandidate(raw?: string | null): string | null {
  let name = String(raw || "")
    .replace(/\s+/g, " ")
    .replace(/^[\s"'“”‘’]+|[\s"'“”‘’.,;:!]+$/g, "")
    .trim();
  name = name.replace(/\s*[|·•–—-]\s*(?:remote|hybrid|on-?site|full[- ]time|part[- ]time|contract)\b.*$/i, "").trim();
  if (name.length < 2 || name.length > 60) return null;
  if (!/^[\p{L}\p{N}]/u.test(name)) return null;
  if (name.split(" ").length > 6) return null;
  if (GENERIC_EMPLOYER.test(name)) return null;
  if (unresolvedCompany(name)) return null;
  if (/^(?:remote|hybrid|worldwide|anywhere|europe|usa?|uk|brazil|latam|emea|apac)$/i.test(name)) return null;
  return name;
}

function jsonLdOrganizations(html: string): string[] {
  const out: string[] = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    let data: unknown;
    try {
      data = JSON.parse(m[1]!);
    } catch {
      continue;
    }
    const root = data as Record<string, unknown> | unknown[];
    const nodes: unknown[] = Array.isArray(root) ? root : Array.isArray((root as Record<string, unknown>)["@graph"]) ? ((root as Record<string, unknown>)["@graph"] as unknown[]) : [root];
    for (const n of nodes) {
      if (!n || typeof n !== "object") continue;
      const node = n as Record<string, unknown>;
      const type = node["@type"];
      const isJob = type === "JobPosting" || (Array.isArray(type) && type.includes("JobPosting"));
      if (!isJob) continue;
      const org = node.hiringOrganization;
      const orgs = Array.isArray(org) ? org : [org];
      for (const o of orgs) {
        if (typeof o === "string") out.push(o);
        else if (o && typeof o === "object" && typeof (o as { name?: unknown }).name === "string") out.push((o as { name: string }).name);
      }
    }
  }
  return out;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Best-effort real employer behind an aggregator page. Sources, strongest first:
 * JSON-LD hiringOrganization, page titles ("<Role> at <Company>", "<Company> is hiring"),
 * then body phrases ("on behalf of <Company>", "Company: <Company>").
 */
export function extractAggregatorEmployer(input: { html?: string | null; title?: string | null; titleCandidates?: string[] | null; text?: string | null; jsonLdCompany?: string | null }): { company: string; via: "json_ld" | "title" | "text" } | null {
  const html = input.html || "";
  for (const raw of [input.jsonLdCompany, ...jsonLdOrganizations(html)]) {
    const name = cleanEmployerCandidate(raw);
    if (name) return { company: name, via: "json_ld" };
  }
  const pageTitle = html.match(/<title>([^<]+)<\/title>/i)?.[1] ?? null;
  const ogTitle = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1] ?? null;
  const titles = [pageTitle, ogTitle, ...(input.titleCandidates || []), input.title].filter((t): t is string => Boolean(t && t.trim()));
  const role = (input.title || "").trim();
  for (const t of titles) {
    const clean = t.replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
    const at = role
      ? clean.match(new RegExp(`^${escapeRe(role)}\\s+(?:at|@)\\s+(.+?)(?:\\s+[|·•–—-]\\s+.*)?$`, "i"))
      : null;
    const atAny = at ?? clean.match(/^.{3,120}?\s+(?:at|@)\s+(.+?)(?:\s+[|·•–—-]\s+.*)?$/i);
    const name = cleanEmployerCandidate(atAny?.[1]);
    if (name) return { company: name, via: "title" };
    const hiring = clean.match(/^(.+?)\s+(?:is\s+)?hiring\b/i);
    const hname = cleanEmployerCandidate(hiring?.[1]);
    if (hname) return { company: hname, via: "title" };
  }
  const text = (input.text || "").slice(0, 20_000);
  const patterns = [
    /\bon behalf of\s+([A-Z][\p{L}\p{N}&'-]*(?: [A-Z][\p{L}\p{N}&'-]*){0,4})/u,
    /\b(?:hiring company|employer|company)\s*:\s*([A-Z][\p{L}\p{N}&'-]*(?: [A-Z][\p{L}\p{N}&'-]*){0,4})/u,
  ];
  for (const re of patterns) {
    const name = cleanEmployerCandidate(text.match(re)?.[1]);
    if (name) return { company: name, via: "text" };
  }
  return null;
}
