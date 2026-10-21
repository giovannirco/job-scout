/**
 * Timezone policy: a timezone / working-hours requirement on its own NEVER
 * blocks, hard_geo-classifies, or auto-archives a role. Only country residency,
 * work authorization, clearance/US-person, or onsite/hybrid requirements block.
 *
 * The profile may set `metadata.acceptableTzRange` ({ min, max } UTC offsets).
 * With a range, a window that does not overlap it is a soft penalty only (at
 * most -0.5 score). Without one (the default) a timezone window only informs:
 * no flag, no penalty.
 */

export type TzRange = { min: number; max: number };

/** Max score penalty for a TZ window outside the acceptable range. */
export const TZ_SOFT_PENALTY = 0.5;

/** The profile's acceptable working-hours window, or null when it sets none. */
export function acceptableTzRangeOf(metadata: unknown): TzRange | null {
  const r = (metadata && typeof metadata === "object" ? (metadata as Record<string, unknown>).acceptableTzRange : null) as
    | Partial<TzRange>
    | null
    | undefined;
  if (!r || typeof r !== "object") return null;
  if (r.min == null || r.max == null || (r.min as unknown) === "" || (r.max as unknown) === "") return null;
  const min = Number(r.min);
  const max = Number(r.max);
  if (Number.isFinite(min) && Number.isFinite(max) && min <= max && min >= -12 && max <= 14) return { min, max };
  return null;
}

/** "UTC-5..UTC+1" */
export function tzRangeLabel(r: TzRange): string {
  const f = (n: number) => `UTC${n >= 0 ? "+" : ""}${n}`;
  return `${f(r.min)}..${f(r.max)}`;
}

const NAMED: Array<[RegExp, TzRange]> = [
  [/\b(pst|pdt|pacific(\s+time)?)\b/i, { min: -8, max: -7 }],
  [/\b(mst|mdt|mountain\s+time)\b/i, { min: -7, max: -6 }],
  [/\b(cst|cdt|central\s+time)\b/i, { min: -6, max: -5 }],
  [/\b(est|edt|eastern(\s+time)?)\b/i, { min: -5, max: -4 }],
  [/\b(brt|brasilia\s+time|bras[ií]lia)\b/i, { min: -3, max: -3 }],
  [/\b(us|u\.s\.|usa|north\s+american?|american)\s+(time\s*zones?|timezones?|tz|hours|business\s+hours|working\s+hours)\b/i, { min: -10, max: -4 }],
  [/\bamericas\b/i, { min: -10, max: -3 }],
  [/\b(latam|latin\s+america|south\s+america)\b/i, { min: -6, max: -3 }],
  [/\b(cet|cest|central\s+european)\b/i, { min: 1, max: 2 }],
  [/\b(emea|europe(an)?|eu)\s*(time\s*zones?|timezones?|tz|hours|business\s+hours|working\s+hours)\b/i, { min: -1, max: 4 }],
  [/\b(apac|asia[-\s]pacific|asian?)\s*(time\s*zones?|timezones?|tz|hours|business\s+hours|working\s+hours)\b/i, { min: 5, max: 12 }],
  [/\b(ist|india\s+standard\s+time)\b/i, { min: 5.5, max: 5.5 }],
  [/\b(sgt|jst|aest|aedt)\b/i, { min: 8, max: 11 }],
];

const OFFSET_RE = /\b(?:utc|gmt)\s*(?:([+\-−–])\s*(\d{1,2})(?::?(\d{2}))?)?/gi;

const TZ_MENTION_RE =
  /\b(time\s*zones?|timezones?|tz|utc|gmt|pst|pdt|est|edt|cst|cdt|mst|mdt|brt|cet|cest|business\s+hours|working\s+hours|(?:hours?|time)\s+overlap|overlap(?:ping)?\s+(?:with|between|of)|(?:pacific|eastern|central|mountain)\s+time|(?:us|emea|apac|est|pst|cet)\s+hours)\b/i;

/** Does the text talk about a timezone / working-hours window at all? */
export function mentionsTimezone(text = ""): boolean {
  return TZ_MENTION_RE.test(text);
}

/** Every timezone window the text names, as UTC offsets. */
export function parseTzWindows(text = ""): TzRange[] {
  const out: TzRange[] = [];
  const offsets: number[] = [];
  for (const m of text.matchAll(OFFSET_RE)) {
    const sign = m[1] ? (m[1] === "+" ? 1 : -1) : 1;
    const h = m[2] ? Number(m[2]) : 0;
    const mins = m[3] ? Number(m[3]) / 60 : 0;
    offsets.push(sign * (h + mins));
  }
  if (offsets.length) out.push({ min: Math.min(...offsets), max: Math.max(...offsets) });
  for (const [re, r] of NAMED) if (re.test(text)) out.push(r);
  return out;
}

export function tzOverlaps(window: TzRange, range: TzRange): boolean {
  return window.min <= range.max && window.max >= range.min;
}

/**
 * Remove timezone / working-hours phrases so what remains can be checked for
 * real blockers. "US time zones" must not read as "US".
 */
export function stripTzPhrases(text = ""): string {
  return text
    .replace(/\boverlap(?:ping)?\s+(?:with|between|of)\b[^.;|\n]*/gi, " ")
    .replace(/\b(?:hours?|time)\s+overlap\b/gi, " ")
    .replace(
      /\b(?:us|u\.s\.|usa|north\s+american?|american|americas|emea|europe(?:an)?|eu|apac|asia[-\s]pacific|asian?|latam|pacific|eastern|central|mountain|est|edt|pst|pdt|cst|cdt|mst|mdt|cet|brt)\s*(?:time\s*zones?|timezones?|tz|time|hours|business\s+hours|working\s+hours)\b/gi,
      " ",
    )
    .replace(/\b(?:utc|gmt)\s*(?:[+\-−–]\s*\d{1,2}(?::?\d{2})?)?/gi, " ")
    .replace(/\b(?:pst|pdt|est|edt|cst|cdt|mst|mdt|brt|cet|cest)\b/gi, " ")
    .replace(/\b(?:time\s*zones?|timezones?|tz|business\s+hours|working\s+hours|overlap)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const COUNTRY =
  "(?:the\\s+)?(?:us|u\\.s\\.?|usa|united\\s+states|america|canada|uk|united\\s+kingdom|eu|europe|germany|france|spain|portugal|netherlands|ireland|poland|india|mexico|argentina|colombia|chile|australia|japan|singapore|israel)";
const RESIDENCY_RE = new RegExp(
  `\\b(?:must\\s+(?:reside|be\\s+(?:based|located)|live)|reside|residen(?:t|cy)|based|located|living)\\s+(?:in|within)\\s+${COUNTRY}\\b|\\b${COUNTRY}[\\s-]+(?:only|based|residents?)\\b|\\bremote\\s*[-–—:(]?\\s*${COUNTRY}\\s*\\)?\\s*$|\\bremote\\s*[-–—:(]\\s*${COUNTRY}\\b|\\b(?:in|within)\\s+${COUNTRY}\\s+only\\b`,
  "i",
);
const WORK_AUTH_RE =
  /\b(work(?:ing)?\s+auth(?:orization|orisation)?|authori[sz]ed\s+to\s+work|right\s+to\s+work|(?:no|without|not\s+(?:offer|provide))\s+(?:visa\s+)?sponsorship|visa\s+sponsorship\s+(?:is\s+)?not|citizen(?:ship)?|green\s*card|permanent\s+resident)\b/i;
const CLEARANCE_RE = /\b(security\s+clearance|clearance\s+required|ts\/sci|secret\s+clearance|us[-\s]person|itar|export\s+control)\b/i;
const ONSITE_RE = /\b(on[\s-]*site|onsite|in[\s-]office|office[\s-]based|hybrid)\b/i;
const CONTRACTOR_PATH_RE = /\b(contractors?|contract\s+basis|independent\s+contractors?|eor|employer\s+of\s+record|deel|remote\.com|oyster)\b/i;

export type BlockKind = "residency" | "work_authorization" | "clearance" | "onsite";

/** Real eligibility blockers present after timezone phrases are removed. */
export function nonTzBlockers(text = ""): BlockKind[] {
  const t = stripTzPhrases(text);
  const out: BlockKind[] = [];
  if (RESIDENCY_RE.test(t) && !CONTRACTOR_PATH_RE.test(t)) out.push("residency");
  if (WORK_AUTH_RE.test(t)) out.push("work_authorization");
  if (CLEARANCE_RE.test(t)) out.push("clearance");
  if (ONSITE_RE.test(t)) out.push("onsite");
  return out;
}

export type TzRequirementVerdict = {
  /** true only for residency / work auth / clearance / onsite blockers */
  block: boolean;
  blockers: BlockKind[];
  timezone: boolean;
  /** 0 without a range, when the window overlaps the range, or when no window parsed */
  penalty: number;
  windows: TzRange[];
};

/** Classify one requirement string (location line, hardDq entry, JD sentence). */
export function evaluateGeoRequirement(text = "", range: TzRange | null = null): TzRequirementVerdict {
  const blockers = nonTzBlockers(text);
  const timezone = mentionsTimezone(text);
  const windows = timezone ? parseTzWindows(text) : [];
  const outside = range != null && windows.length > 0 && !windows.some((w) => tzOverlaps(w, range));
  return { block: blockers.length > 0, blockers, timezone, penalty: timezone && outside ? TZ_SOFT_PENALTY : 0, windows };
}

/** A timezone requirement with nothing else that blocks. */
export function isTimezoneOnlyRestriction(text = ""): boolean {
  return mentionsTimezone(text) && nonTzBlockers(text).length === 0;
}

type TriageLike = {
  score: number;
  archetype: number;
  comp: number;
  location: number;
  cvMatch: number;
  hardDq: string[];
  softFlags: string[];
  locationNote: string;
  oneLiner: string;
};

const TZ_FLAG = /\btimezone\b/i;

/**
 * Enforce the timezone policy on an LLM triage result: timezone-only hardDqs
 * are dropped (demoted to one soft flag only when a range is set and the window
 * is outside it) and the score is recomputed from the dimensions.
 */
export function applyTzPolicy<T extends TriageLike>(
  out: T,
  range: TzRange | null = null,
): { out: T; adjusted: boolean; removed: string[]; penalty: number } {
  const removed: string[] = [];
  let penalty = 0;
  const hardDq: string[] = [];
  for (const d of out.hardDq) {
    const v = evaluateGeoRequirement(d, range);
    if (v.timezone && !v.block) {
      removed.push(d);
      penalty = Math.max(penalty, v.penalty);
    } else hardDq.push(d);
  }
  const noteV = evaluateGeoRequirement(`${out.locationNote || ""}`, range);
  const locationTzOnly = noteV.timezone && !noteV.block && out.location < 4;
  if (!removed.length && !locationTzOnly) return { out, adjusted: false, removed, penalty: 0 };
  penalty = Math.max(penalty, locationTzOnly ? noteV.penalty : 0);
  const softFlags = [...out.softFlags];
  if (penalty > 0 && range && !softFlags.some((f) => TZ_FLAG.test(f))) softFlags.push(`timezone window outside ${tzRangeLabel(range)} (soft)`);
  const location = Math.max(out.location, 4);
  let score = out.score;
  if (!hardDq.length) {
    const otherSoft = softFlags.filter((f) => !TZ_FLAG.test(f)).length;
    const base = out.archetype * 0.35 + location * 0.25 + out.cvMatch * 0.25 + out.comp * 0.15 - 0.5 * otherSoft;
    score = Math.max(out.score, Math.round(Math.max(0, Math.min(5, base - penalty)) * 10) / 10);
  }
  return {
    out: { ...out, hardDq, softFlags, location, score },
    adjusted: true,
    removed,
    penalty,
  };
}
