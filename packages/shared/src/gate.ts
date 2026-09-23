import { isNamedOffice } from "./classify.js";
import type { GateConfig } from "./settings.js";

export type GateInput = {
  title: string;
  locationRaw?: string | null;
  workplaceType?: string | null;
  postedAt?: string | Date | null;
  now?: Date;
};

export type GateVerdict = {
  pass: boolean;
  /** Short machine-readable reason: title_exclude:<term>, title_no_include, geo_block:<term>, geo_unknown, stale:<days> */
  reason: string | null;
  matchedInclude: string | null;
};

function norm(s: string | null | undefined): string {
  return (s || "").toLowerCase().replace(/[\u2013\u2014]/g, "-").replace(/\s+/g, " ").trim();
}

/** Word-ish containment: a term with spaces/punct is a substring; a bare word must be bounded. */
function has(blob: string, term: string): boolean {
  const t = norm(term);
  if (!t) return false;
  if (/[^a-z0-9]/.test(t)) return blob.includes(t);
  return new RegExp(`(^|[^a-z0-9])${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`).test(blob);
}

/** Phrases that mean the same thing as a configured exclude, so a saved gate keeps working. */
const EXCLUDE_ALIASES: Record<string, string[]> = {
  junior: ["new graduate", "new grad", "early career"],
  intern: ["internship"],
};

function excludeHits(title: string, term: string): string | null {
  const configured = norm(term);
  if (!configured) return null;
  if (has(title, configured)) return configured;
  for (const alias of EXCLUDE_ALIASES[configured] || []) {
    if (has(title, alias)) return alias;
  }
  return null;
}

/** Engineer and developer are the same job shape. "software engineer" also matches "software developer". */
function includeTerms(term: string): string[] {
  const t = norm(term);
  if (!t) return [];
  if (t.endsWith(" engineer")) return [t, `${t.slice(0, -" engineer".length)} developer`];
  if (t.endsWith(" developer")) return [t, `${t.slice(0, -" developer".length)} engineer`];
  return [t];
}

/**
 * Deterministic pre-LLM gate. Cheap, explainable, tunable from Settings > Gate.
 * Order: exclude title -> require include title -> stale -> geo block -> geo allow/unknown.
 */
export function gateListing(input: GateInput, cfg: GateConfig): GateVerdict {
  const title = norm(input.title);
  const geo = norm([input.locationRaw, input.workplaceType].filter(Boolean).join(" | "));

  for (const term of cfg.titleExclude) {
    const hit = excludeHits(title, term);
    if (hit) return { pass: false, reason: `title_exclude:${hit}`, matchedInclude: null };
  }

  let matchedInclude: string | null = null;
  for (const term of cfg.titleInclude) {
    const hit = includeTerms(term).find((candidate) => has(title, candidate));
    if (hit) {
      matchedInclude = hit;
      break;
    }
  }
  if (cfg.titleInclude.length && !matchedInclude) {
    return { pass: false, reason: "title_no_include", matchedInclude: null };
  }

  if (cfg.maxPostingAgeDays > 0 && input.postedAt) {
    const posted = input.postedAt instanceof Date ? input.postedAt : new Date(input.postedAt);
    if (!Number.isNaN(posted.getTime())) {
      const now = input.now ?? new Date();
      const days = Math.floor((now.getTime() - posted.getTime()) / 86_400_000);
      if (days > cfg.maxPostingAgeDays) {
        return { pass: false, reason: `stale:${days}d`, matchedInclude };
      }
    }
  }

  // Geo: a block term wins unless an explicit allow term is also present and stronger
  // ("Remote - Brazil" contains "remote" allow and no block; "Hybrid - São Paulo" is blocked).
  for (const term of cfg.geoBlock) {
    if (has(geo, term)) {
      return { pass: false, reason: `geo_block:${term.trim()}`, matchedInclude };
    }
  }
  if (!geo) {
    return cfg.allowUnknownGeo
      ? { pass: true, reason: "geo_unknown", matchedInclude }
      : { pass: false, reason: "geo_unknown", matchedInclude };
  }
  for (const term of cfg.geoAllow) {
    if (has(geo, term)) return { pass: true, reason: null, matchedInclude };
  }
  // "Spain" is a place, not an unknown location. allowUnknownGeo only covers a blank.
  if (isNamedOffice(input.locationRaw || "")) {
    return { pass: false, reason: "geo_unlisted", matchedInclude };
  }
  return cfg.allowUnknownGeo
    ? { pass: true, reason: "geo_unlisted", matchedInclude }
    : { pass: false, reason: "geo_unlisted", matchedInclude };
}
