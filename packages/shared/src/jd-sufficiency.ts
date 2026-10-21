/**
 * Is there enough job description to score? A posting stored with a JD that is
 * only its title (or a few words of page chrome) must not be triaged, evaluated
 * or researched: the model would score nothing. Such a position is kept, never
 * refused, and flagged `metadata.needsJd` until a fuller JD arrives.
 */
export const MIN_JD_WORDS = 25;
export const MIN_JD_CHARS = 120;

export type JdSufficiency = {
  sufficient: boolean;
  /** Words left once the title and page chrome are removed. */
  words: number;
  chars: number;
  reason?: "empty" | "title_only" | "too_short";
};

function words(text: string): string[] {
  return text.toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "").split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/** Chrome that a careers page wraps around a missing JD. */
const CHROME_WORDS = new Set([
  "apply", "now", "job", "jobs", "back", "to", "share", "this", "careers", "career", "home", "view", "all", "openings",
  "opening", "position", "role", "save", "login", "sign", "in", "powered", "by", "cookies", "accept", "privacy", "policy",
  "full", "time", "remote", "hybrid", "onsite", "location", "department", "the", "a", "an", "and", "of", "at", "for",
]);

export function jdSufficiency(title: string | null | undefined, descriptionText: string | null | undefined): JdSufficiency {
  const body = (descriptionText || "").replace(/\s+/g, " ").trim();
  if (!body) return { sufficient: false, words: 0, chars: 0, reason: "empty" };
  const titleWords = new Set(words(title || ""));
  const rest = words(body).filter((w) => !titleWords.has(w));
  const meaningful = rest.filter((w) => !CHROME_WORDS.has(w));
  const chars = rest.join(" ").length;
  if (!meaningful.length) return { sufficient: false, words: 0, chars, reason: "title_only" };
  if (rest.length < MIN_JD_WORDS || chars < MIN_JD_CHARS) return { sufficient: false, words: rest.length, chars, reason: "too_short" };
  return { sufficient: true, words: rest.length, chars };
}

/** Body text shared by two JDs as a 0..1 token overlap (1 = same words). */
export function jdWordOverlap(a: string | null | undefined, b: string | null | undefined): number {
  const x = new Set(words(a || ""));
  const y = new Set(words(b || ""));
  if (!x.size && !y.size) return 1;
  if (!x.size || !y.size) return 0;
  let inter = 0;
  for (const w of x) if (y.has(w)) inter++;
  return inter / (x.size + y.size - inter);
}

/**
 * A rewrite, not an edit: the body kept less than half its words. Used to
 * decide whether earlier scoring describes a different JD.
 */
export function jdSubstantiallyRewritten(before: string | null | undefined, after: string | null | undefined): boolean {
  return jdWordOverlap(before, after) < 0.5;
}

/** Paid follow-ups (jd_review, the Jev fit check) run at most once per window for plain description edits. */
export const JD_FOLLOWUP_WINDOW_MS = 24 * 3_600_000;

/** Change kinds that always earn a follow-up: the JD arrived, or title/pay/location/status moved. */
const FOLLOWUP_KINDS = new Set(["first_seen", "jd_arrived", "title", "comp", "geo", "closed", "reopened", "status"]);

export function bypassesFollowUpLimit(changeKind?: string | null): boolean {
  return FOLLOWUP_KINDS.has(changeKind || "");
}
